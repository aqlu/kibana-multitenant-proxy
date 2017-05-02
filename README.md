"# kibana-multitenant-proxy"

支持kibana 5.1


该Proxy实现Kibana4访问Elasticsearch时数据的多租户数据访问隔离（一个用户只能看到限定的index）、字段脱敏、单Index查询范围限制等功能。欢迎试用和pr，提出宝贵意见和Star~

离线包还未上传，请稍候，  着急用的可以先在线安装后自己打包放到无法连接互联网的环境中即可~

A proxy behind nginx while before kibana to provide data isolation for different users


##Why Nodejs?
因为Kibana发行版自带了一个node，为了部署简便并且鉴于Kibana实际访问不会有太大的并发量，因此选择NodeJS，并非对此语言熟悉。

##架构图
![](https://raw.githubusercontent.com/gnuhpc/kibana-multitenant-proxy/master/docs/arch.jpg)

* 如图所示，通过将Kibana的配置文件kibana.yml配置为server.host: "localhost" ，可以屏蔽本地地址之外的IP对Kibana的5601端口进行访问，从而保证本地地址之外的IP只能通过9999和对Kibana进行访问，而通过代理的访问将是可控的，并且有相应访问日志可供查询。
* 代理借助Nginx的Basic Auth实现了用户的认证。
* 客户端浏览器通过9999端口访问Kibana时，首先需要进行用户认证，Nginx验证通过后，Kibana Proxy对请求中的用户名和访问的Index进行校验，只有符合权限的请求才会被放行，实现了不同用户组的数据隔离。用户名和所能访问的index前缀，例如配置了logstash-cbank权限后，该用户将可以访问所有以logstash-cbank开头的index，如logstash-cbank-2016.08.26等。

##安装准备
* 安装nodejs（安装完Kibana即可）
* 离线安装包kibana_proxy.tar.gz
* 若无离线安装包亦可连接至公网通过npm进行在线下载


##安装步骤
* 离线模式：解压kibana_proxy.tar.gz
 *  `tar -zxvf kibana_proxy.tar.gz`
* 在线模式：通过npm安装
 * `npm install kibana_proxy`
* 添加环境变量：将nodejs路径添加到PATH中
 * `export PATH=/logger/kibana-4.5.1-linux-x64/node/bin:$PATH`
* 运行
 * 进入工程目录 `cd kibana_proxy`
 * 启动 `nohup node app.js &`
 * 显示 `The proxy is listening on port xxxx` 说明启动成功

##代理配置
* kibana_proxy配置采用json格式，相关信息配置在config.json文件中
  *  `"port": "8888",` 代理监听端口，required
  * `"refresh_port": "8889",` 配置以及用户信息刷新监听端口，required
  * `"kibana_server": "http://127.0.0.1:5601",`后端指向kibana地址以及端口，required
  * `"es_server":"http://127.0.0.1:9201/",` 存放用户权限的ElasticSearch地址以及端口，required
  * `"es_user_index":".sys_auth",` 存放用户权限的索引名，required
  * `"es_user_type":"user_info",` 存放用户权限的索引类型名，optional
  * `"default_privileges":["logstash.+"],` 用户默认权限，数组。名称支持正常表达式，也可全名匹配。optional
  * 数据脱敏配置`data_mask_config`支持多个index前缀以及多个字段，并且支持正则表达式匹配，optional。如下所示，将index前缀为`logstash`的index的`APP_LOG`中的`message`字段里所有的`2016`替换为`xxxx`，`@version`字段中所有的`1`替换为`x`：
    `{"index_prefix":"logstash","type":"APP_LOG", "maskFields":[{"field":"message","reg":"/2016/g","value":"xxxx"},{"field":"@version","reg":"/1/g","value":"x"}]},`

##使用注意事项
* Nginx相关配置
  * 如果借助Nginx的Basic Auth实现用户的认证，需要使用htpassword在Nginx服务器端生成用户密码文件。
  * 如果借助Nginx的LDAP模块来鉴权，需要使用使用[nginx-auth-ldap](https://github.com/kvspb/nginx-auth-ldap)模块。
  * 本代理在架构层面位于Nginx和Kibana之间，需要在Nginx中配置相应的端口映射，将用户访问的Nginx端口映射至proxy监听端口。
* 用户权限配置（Proxy进程启动后，若要及时更新权限信息可以过访问刷新监听端口完成，http://localhost:8889/refresh ）
  * 添加用户权限：
    ```js
    PUT /.sys_auth/user_info/{user}
    {
      "user": {user},
      "indices": [
        "ALL"
      ]
    }
    ```
    `indices`支持说明：可以是索引的全名、也可以是正则表达式、"ALL"表示拥有所有权限。只有拥有"ALL"权限的用户才能使用kibana的`Dev Tools`功能。
* Kibana相关配置
  * 通过将Kibana的配置文件`kibana.yml`配置为`server.host: "localhost"` ，可以屏蔽本地地址之外的IP对Kibana的5601端口访问，从而保证本地地址之外的IP只能通过Nginx和代理对Kibana进行访问，而通过代理的访问将是可控的，并且Nginx有相应访问日志可供查询
* Proxy权限与相关配置信息刷新
  * 代理启动时会对用户权限和相关配置信息进行同步，如果在运行状态，需要刷新相关信息，可访问代理的8889端口（可以进行配置）进行刷新
