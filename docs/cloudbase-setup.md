# 部署到自己的 CloudBase

本项目使用 PostgreSQL，不要求启用旧版 NoSQL。已在 ap-shanghai 的 PostgreSQL 17.11 环境验证。请在自己的环境中部署，不要照抄在线体验的环境 ID。

## 准备

1. 安装 Node.js 20.19+，运行 npm ci。
2. 在 CloudBase 创建或选择自己的 PostgreSQL 环境，并开通需要的云函数、HTTP 网关和静态托管。
3. 安装并登录官方 CLI。本次验收使用 @cloudbase/cli 3.8.6。
4. 复制 .env.example 为 .env，填写自己的 JOURNAL_ENV_ID、JOURNAL_REGION、JOURNAL_APP_URL。网页 URL 使用 HTTPS，部署在域名根目录。
5. 将 JOURNAL_CLI_BIN 设置为官方 @cloudbase/cli 包里的 bin/tcb 的绝对路径。开始时可将 JOURNAL_WIDGET_URL 留空，创建路由后再填入。

```powershell
npm install -g @cloudbase/cli@3.8.6
tcb login
Copy-Item .env.example .env
Join-Path ((npm root -g).Trim()) '@cloudbase/cli/bin/tcb'
```

最后一条命令输出 CLI 路径，请填写进 .env。该文件包含本机配置，已被 Git 忽略。后端 CLOUDBASE_API_KEY 可留空，由首次 backend 部署创建专用 service_role API Key；已有密钥只供服务端使用。

## 首次部署顺序

先检查和构建自己的环境：

```powershell
npm run check
npm test
node --env-file=.env scripts/build.mjs
node --env-file=.env scripts/deploy-cloudbase.mjs backends
```

backends 会应用专用迁移、创建后端凭据，并部署 journal 和 journal-widget。若有同名函数但本地部署记录未跟踪，脚本拒绝覆盖它们。请使用专用环境，先检查已有资源。

- journal 是 Event 函数，验证登录身份后处理笔记和小组件授权。
- journal-widget 是 HTTP 函数，监听 9000，使用 LF、无 BOM 的启动脚本，只接受带独立只读凭据的 GET。
- 两者使用 Nodejs20.19，SDK 和依赖已内联，无需云端 npm 安装。
- 数据库使用 public.shiye_documents 保存 JSONB 文档；普通用户不能直接读写笔记或调用存储 RPC，sync_meta 仅可读取本人行。
- API Key 只写入两个函数的环境变量，不进入网页或 Scriptable。成功部署后删除临时密钥文件。

如果需要邮箱自助注册，显式启用邮箱登录和平台邮件代发，然后建立小组件路由：

```powershell
node --env-file=.env scripts/deploy-cloudbase.mjs email
node --env-file=.env scripts/deploy-cloudbase.mjs route
```

email 会保留已有手机号、用户名和匿名登录开关，仅开启邮箱配置。此步骤修改认证设置；执行部署命令的账号需具有对应权限。未启用邮箱时，后续构建不要传 --email-login。

route 输出 /api/widget/today 的实际 HTTPS 地址，同时记录在 .runtime/cloud-deployment.json。将这个地址填入 .env 的 JOURNAL_WIDGET_URL，再重新构建并发布：

```powershell
node --env-file=.env scripts/build.mjs --email-login
node --env-file=.env scripts/deploy-cloudbase.mjs permissions
node --env-file=.env scripts/deploy-cloudbase.mjs hosting
```

permissions 将自己的网页域名加入 CloudBase 安全域名。hosting 使用 --entry index.html 最后上传入口，并通过 HTTPS 逐个核对文件 SHA-256；不会自动清理远端其它文件。

网页登录与邮箱验证码实际收信需本人验证。首次登录可选择合并此设备旧笔记。手机安装和小组件配置见 [iPhone 说明](iphone-setup.md)。

## 配置和再次更新

CLI 参数 --env、--region、--app-url、--widget-url 可覆盖环境变量；.runtime/cloud-deployment.json 缓存部署归属，拒绝切换到另一个环境。每个环境使用独立项目目录。

重新构建后，可使用官方 CLI 的代码更新命令，保留原函数环境变量：

```powershell
tcb fn code update journal --dir dist/functions/journal -e 你的环境ID
tcb fn code update journal-widget --dir dist/functions/journal-widget -e 你的环境ID
node --env-file=.env scripts/deploy-cloudbase.mjs hosting
```

再次运行 backends 不会自行轮换已部署凭据。部署前保留旧构建和数据库备份。不要提交 .runtime、.env、账号凭据或笔记导出文件。

## 可选云端验收

以下步骤会创建两个随机临时账号、写入测试记录，再删除这些账号与记录。仅在自己有权操作的测试环境运行：

```powershell
node --env-file=.env scripts/cloud-smoke.mjs create
node --env-file=.env scripts/cloud-smoke.mjs smoke
node --env-file=.env scripts/cloud-smoke.mjs cleanup
```

即使 smoke 失败，也应运行 cleanup。脚本不发送邮件，不提取后端密钥，清理仅针对它创建并记录的测试身份。结果报告不含密码或令牌。

## 平台限制与官方文档

默认测试域名会出现腾讯云访问提示；正式使用请绑定已备案的自定义域名。无法通过修改本项目页面移除该提示。

CLI 3.8.6 在本次 Windows 根目录发布中，--safe/--verify 误报文件缺失并回滚，因此本项目改用独立 HTTPS 内容校验。网关内部默认域名使用官方 service create 建立函数路径。

- [默认域名访问提示](https://docs.cloudbase.net/service/alias)
- [PostgreSQL 初始化](https://docs.cloudbase.net/database/postgresql/initialization)
- [RPC 权限与角色](https://docs.cloudbase.net/database/postgresql/rpc)
- [云函数代码包](https://docs.cloudbase.net/cloud-function/develop/how-to-writing-functions-code)
- [官方 CLI](https://docs.cloudbase.net/cli-v1/quick-start)
- [邮箱注册接口](https://docs.cloudbase.net/http-api/auth/auth-sign-up)
