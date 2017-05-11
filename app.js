'use strict';

//noinspection JSUnresolvedFunction
/**
 *
 * Created by angus on 2017/04/28.
 */
var config = require("./config.json");
const hoxy = require('hoxy');

const port = config.port;
const refresh_port = config.refresh_port;

const proxy = hoxy.createServer({
  reverse: config.kibana_server
});
const es_server = config.es_server.endsWith("/") ? config.es_server : config.es_server + "/";

const es_user_index = config.es_user_index || ".sys_auth";
const es_user_type = config.es_user_type || "user_info";

const default_privileges = config.default_privileges || [];
const data_mask_config = config.data_mask_config;

var authInfo = {};
var refreshFlag;

/**
 * 校验用户是否有对应索引的权限
 */
function validatePrivilege(user, indexName) {

  //logger.info("validatePrivilege in ...", user, indexName);

  if (indexName == '.kibana') { //不校验.kibana索引的权限
    return true;
  }

  user = user.toLowerCase();

  var userIndices = authInfo[user] ? authInfo[user] : default_privileges; // 默认都赋予查询logstash*的权限

  for (var i = 0; i < userIndices.length; i++) {
    // 索引名相等、权限为ALL、权限正则相匹配都判定为校验通过
    if (userIndices[i] == "ALL" || indexName == userIndices[i] || new RegExp(userIndices[i]).test(indexName)) {
      return true;
    }
  }
  return false;
}

function ifGetUserInfo() {
  // check need to get userinfo or not
  if (typeof refreshFlag == 'undefined') {
    refreshFlag = true;
    logger.info('first time to refresh user');
  }

  if (refreshFlag) {
    syncUserInfo();
    refreshFlag = false;
  }
}

/**
 * 同步用户权限信息
 */
function syncUserInfo() {
  // get index that user can access
  var request = require("sync-request");

  var res = request('GET', es_server + es_user_index + "/" + es_user_type + '/_search?q=user:*');
  if (res.statusCode >= 200 && res.statusCode < 300) {
    var strResData = res.getBody().toString();
    var userResp = JSON.parse(strResData);

    authInfo = {}; // 清空之前缓存的用户信息

    for (var i = 0; i < userResp['hits']['hits'].length; i++) {
      var user = userResp['hits']['hits'][i]['_source']['user'].toLowerCase();
      authInfo[user] = userResp['hits']['hits'][i]['_source']['indices'];
    }

    logger.info('sync user info success, authInfo:' + JSON.stringify(authInfo));
  } else {
    logger.warn('sync user info failed.' + res);
  }

}

var http = require('http');
http.createServer(function (request, response) {
  if (request.url == "/refresh") {
    syncUserInfo(); // 刷新用户权限

    var fs = require('fs'); // 刷新配置
    config = JSON.parse(fs.readFileSync('./config.json'));
    logger.info("sync config:" + JSON.stringify(config));


    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(authInfo));
  } else {
    response.writeHead(200, {'Content-Type': 'text/html'});
    response.end('You can use "<a href="/refresh">/refresh></a>" to refresh user info. \n');
  }
}).listen(refresh_port);

//noinspection JSUnusedLocalSymbols,JSUnresolvedFunction
/**
 * json响应结果前拦截，执行数据脱敏
 */
proxy.intercept({
  phase: 'response',
  mineType: 'application/json',
  url: '/elasticsearch/_msearch', // Discover拉去索引数据请求
  as: 'json'
}, function (req, resp, cycle) {

  // logger.info("reponse /elasticsearch/_msearch in ...");

  if (data_mask_config && data_mask_config.length > 0) { // 是否有脱敏配置

    // 判断响应结果是否包含数据
    if (resp && resp._data && resp._data.statusCode >= 200 && resp._data.statusCode < 300 && "responses" in resp._data.source._obj && resp._data.source._obj.responses[0].hits.hits.length > 0) {

      var kibanaResp = resp._data.source._obj;
      var hits = kibanaResp.responses[0].hits.hits;

      var blurFunc = function (hit) {
        for (var i = 0; i < data_mask_config.length; i++) { // 遍历所有脱敏配置项
          var mask = data_mask_config[i];
          if (hit._index.startsWith(mask.index_prefix) && hit._type == mask.type) { // index与type都匹配
            for (var j = 0; j < mask.mask_fields.length; j++) {  // 遍历数据里面的字段
              var mask_field = mask.mask_fields[j];
              if (hit._source[mask_field.field]) {
                hit._source[mask_field.field] = hit._source[mask_field.field].replace(eval(mask_field.reg), mask_field.value);
              }
            }
          }
        }

        return hit;
      };

      hits.map(blurFunc); // 数据脱敏
    }
  }
});

//noinspection JSUnusedLocalSymbols,JSUnresolvedFunction
/**
 * 请求进来前拦截，进行用户授权检查
 */
proxy.intercept({
  phase: 'request',
  url: '/elasticsearch/_msearch', // Discover拉去索引数据请求
  method: 'POST',
  as: 'string'
}, function (req, resp, cycle) {
  // logger.info("request /elasticsearch/_msearch in ...");

  var req_user = req._data['headers']['remote_user'],
    x_real_ip = req._data['headers']['x-real-ip'],
    x_forwarded_for = req._data['headers']['x-forwarded-for'];

  ifGetUserInfo();

  if (!req_user) {
    logger.warn("[Discover], can not get user! x-real-ip:[" + x_real_ip + "], x-forwarded-for: [" + x_forwarded_for + "]");
    response_no_privilege(resp, undefined);
    return;
  }

  var req_params = req.string.split('\n');
  var index_name = JSON.parse(req_params[0])['index'];
  if (index_name instanceof Array) {
    index_name = index_name[0];
  }

  // 校验用户是否具有对应的index权限；
  if (!validatePrivilege(req_user, index_name)) {
    logger.warn("[Discover], [" + req_user + "] no have [" + index_name + "] privilege! x-real-ip:[" + x_real_ip + "], x-forwarded-for: [" + x_forwarded_for + "]");
    response_no_privilege(resp, req_user);

    // req.string = req.string.replace(index_name, 'null');
    // logger.info(index_name + ' has been changed to null');
  }
});

/**
 * 请求进来前拦截，进行用户授权检查
 * DevTools发送的请求
 */
proxy.intercept({
  phase: 'request',
  url: '/api/console/proxy', //DevTools发出的请求
  as: 'string'
}, function (req, resp, cycle) {
  logger.info("request /api/console/proxy in ...");

  var req_user = req._data['headers']['remote_user'],
    x_real_ip = req._data['headers']['x-real-ip'],
    x_forwarded_for = req._data['headers']['x-forwarded-for'];

  ifGetUserInfo();

  if (!req_user) {
    logger.warn("[DevTools], can not get user! x-real-ip:[" + x_real_ip + "], x-forwarded-for: [" + x_forwarded_for + "]");
    response_no_privilege(resp, undefined);
    return;
  }

  // 校验用户是否具有ALL权限；DevTools必须要拥有ALL的权限；
  if (!validatePrivilege(req_user, "ALL")) {
    logger.warn("[DevTools], [" + req_user + "] no have [ALL] privilege. DevTools must have 'ALL' privilege. x-real-ip:[" + x_real_ip + "], x-forwarded-for: [" + x_forwarded_for + "]");
    response_no_privilege(resp, req_user);
  }
});

const response_no_privilege = function (resp, req_user) {
  var now = new Date().getTime();
  no_privilege_resp.responses[0].hits.hits[0]._id = now;
  no_privilege_resp.responses[0].hits.hits[0]._source["@timestamp"] = format(now);
  no_privilege_resp.responses[0].hits.hits[0].fields["@timestamp"] = [now];
  no_privilege_resp.responses[0].hits.hits[0]._source["message"] = req_user ? "[" + req_user + "], 你没有相关权限！" : "请先登录再访问！";
  no_privilege_resp.responses[0].hits.hits[0].highlight["message"] = ["@kibana-highlighted-field@" + no_privilege_resp.responses[0].hits.hits[0]._source.message + "@/kibana-highlighted-field@"];

  // resp.statusCode = 401; //TODO 不返回401是因为kibana在没安装xpack的权限包时，会陷入死循环。
  resp.statusCode = 200;
  resp.headers = {"content-type": "application/json"};
  resp.json = no_privilege_resp;
};

proxy.listen(port, function () {
  logger.info('The proxy is listening on port ' + port + '.');
});

const logger = {
  info: function (msg) {
    console.log(format(new Date()) + ": [INFO]: " + msg);
  },
  warn: function (msg) {
    console.warn(format(new Date()) + ": [WARN]: " + msg);
  },
  error: function (msg) {
    console.error(format(new Date()) + ": [ERROR]: " + msg);
  }
};

const add0 = function (m) {
  return m < 10 ? '0' + m : m
};

const format = function (mills) {
  //mills是整数，否则要parseInt转换
  var time = new Date(mills);
  var y = time.getFullYear();
  var m = time.getMonth() + 1;
  var d = time.getDate();
  var h = time.getHours();
  var mm = time.getMinutes();
  var s = time.getSeconds();

  return y + '-' + add0(m) + '-' + add0(d) + 'T' + add0(h) + ':' + add0(mm) + ':' + add0(s) + 'Z+0800';
};

var no_privilege_resp = {
  "responses": [
    {
      "took": 1,
      "timed_out": false,
      "_shards": {
        "total": 1,
        "successful": 1,
        "failed": 0
      },
      "hits": {
        "total": 1,
        "max_score": null,
        "hits": [
          {
            "_index": "NO_PRIVILEGE",
            "_type": "NO_PRIVILEGE",
            "_id": "1",
            "_score": null,
            "_source": {
              "@timestamp": "",
              "level": "WARN",
              "message": "你没有相关权限"
            },
            "fields": {
              "@timestamp": [
                1
              ]
            },
            "highlight": {
              "message": [
                "@kibana-highlighted-field@你没有相关权限@/kibana-highlighted-field@"
              ],
              "level": ["@kibana-highlighted-field@WARN@/kibana-highlighted-field@"]
            },
            "sort": [
              1
            ]
          }
        ]
      },
      "aggregations": {
        "2": {
          "buckets": []
        }
      },
      "status": 200
    }
  ]
};