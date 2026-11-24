# 飞书云文档（DSH 插件）

通过飞书用户 OAuth 登录，让 DeepSeek Harness 助手访问你的飞书云文档：

- **云盘**：浏览根目录与文件夹、识别快捷方式、下载文件。
- **知识库**：列出知识库空间与节点树，解析知识库链接，读取其中的文档、表格和文件。
- **文档**：读取新版文档（Docx）正文，新建文档，追加写入（不覆盖）。
- **表格**：读取电子表格的工作表清单与单元格区域。

## 一次性配置

1. 在[飞书开放平台](https://open.feishu.cn/app)创建一个**企业自建应用**，取得 App ID 和 App Secret。
2. 在应用的「开发配置 → 权限管理」开通：
   - `offline_access`（保存并刷新登录）
   - `drive:drive:readonly`（浏览云盘、下载文件）
   - `wiki:wiki:readonly`（读取知识库空间与节点）
   - `docx:document`（读取、新建和编辑新版文档）
   - `sheets:spreadsheet:readonly`（读取电子表格）
3. 在「开发配置 → 安全设置 → 重定向 URL」添加：
   - `http://127.0.0.1:18923/oauth/callback`
4. 按应用的发布流程创建版本并发布，确保当前用户在可用范围内。
5. 把 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 放入 Harness 凭据存储；也可用同名环境变量提供。插件不会把 App Secret 或用户令牌写入会话。
6. 如果端口被占用，修改插件配置 `callbackPort`，并同步修改飞书后台的重定向 URL。

> 授权页会申请上面列出的全部权限。如果应用后台没有开通其中某一项，飞书会在授权时报 20027；如果登录后缺少某权限，`feishu_auth` 的 `status` 会列出 `missingScopes`，重新 `login` 即可补充授权（用户授予的权限是累积的）。

## 使用

让助手执行“登录飞书”，或调用 `feishu_auth` 的 `login`。打开返回的 `authorizationUrl` 完成授权，随后再查一次 `status`。

工具：

| 工具 | 用途 |
| --- | --- |
| `feishu_auth` | 登录、查看状态（含已授权/缺失权限）、退出。 |
| `feishu_drive_list` | 列出云盘根目录或某个文件夹，返回可继续使用的 token；自动展开快捷方式。 |
| `feishu_wiki_spaces` | 列出有权访问的知识库空间。 |
| `feishu_wiki_nodes` | 列出知识库节点树，`space_id=my_library` 可浏览「我的文档库」。 |
| `feishu_wiki_node` | 解析知识库链接，得到 `objType` / `objToken` 与所属空间。 |
| `feishu_doc_read` | 读取 Docx 纯文本，支持 `/docx/` 与 `/wiki/` 链接。 |
| `feishu_doc_create` | 在云盘文件夹新建 Docx，可同时写入初始正文。 |
| `feishu_doc_append` | 向 Docx 末尾追加正文，不覆盖原内容。 |
| `feishu_sheet_read` | 读取电子表格的工作表清单与单元格区域。 |
| `feishu_file_download` | 把云盘或知识库中的二进制文件下载到本地。 |

### 典型流程

1. `feishu_drive_list` 浏览云盘，或用 `feishu_wiki_spaces` → `feishu_wiki_nodes` 浏览知识库。
2. 拿到链接或 token 后：
   - 新版文档 → `feishu_doc_read`
   - 电子表格 → `feishu_sheet_read`
   - 普通文件 → `feishu_file_download`
   - 知识库里的节点 → 直接把知识库链接交给对应工具，插件会自动解析成底层文档。
3. 需要写文档时用 `feishu_doc_create` / `feishu_doc_append`。

写入支持普通文本、一至六级标题、无序/有序列表、引用和三反引号代码块。

### 下载目录

`feishu_file_download` 的 `directory` 省略时保存到用户主目录下的 `feishu-downloads`。也可以传绝对路径，或相对 Harness 进程工作目录的路径。同名文件不会覆盖，而是追加 ` (1)`、` (2)` 等后缀。默认单文件上限 50 MB，可用 `max_bytes` 调整。

## 当前不支持

- 旧版文档（Doc）、多维表格（Bitable）、思维笔记（Mindnote）、幻灯片（Slides）：会返回明确的类型提示，不会静默失败。
- 在知识库中直接新建文档：请先在云盘创建，再在飞书中移动到知识库。
- 云文档全文搜索：飞书搜索 API 需要额外的应用权限与审核，本插件未申请。

用户只能访问其飞书账号本身有权访问的文档。插件不会绕过文档分享权限。

## 实现说明

- OAuth 使用飞书 v3 令牌端点；应用为机密客户端（有 client_secret），并以随机 `state` 防回环 CSRF。飞书授权页的 PKCE 只兼容旧版 v2 令牌端点，故未启用。
- 用户令牌保存在 Harness `credentials` 服务的 `feishu-docs/user-grant` 记录中，刷新时原子更新一次性 refresh token。
- 登录回调仅监听 `127.0.0.1`，5 分钟超时，并校验随机 `state`。
- 表格读取使用 v3 工作表查询 + v2 取值接口；单元格中的富文本、链接和公式会尽量拍平成文本。
- 下载前先检查 `Content-Length`，并设置 120 秒超时，避免把超大文件读进内存。

参考：[获取授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)、[获取 user_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)、[云盘文件清单](https://open.feishu.cn/document/server-docs/docs/drive-v1/folder/list)、[下载文件](https://open.feishu.cn/document/server-docs/docs/drive-v1/download/download)、[知识库空间列表](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space/list)、[知识库节点列表](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/list)、[获取知识库节点](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/get_node)、[读取纯文本](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content)、[电子表格工作表查询](https://open.feishu.cn/document/server-docs/docs/sheets-v3/spreadsheet-sheet/query)、[读取单元格](https://open.feishu.cn/document/server-docs/docs/sheets-v3/data-operation/reading-data)。
