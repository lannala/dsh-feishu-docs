import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { markdownToBlocks } from './markdown.js';

export const name = 'feishu-docs';
export const inject = ['tools', 'credentials'];

const CREDENTIAL_KEY = 'feishu-docs/user-grant';
const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
const API_ORIGIN = 'https://open.feishu.cn';
const DEFAULT_SCOPE = 'offline_access drive:drive:readonly wiki:wiki:readonly docx:document sheets:spreadsheet:readonly';
const AUTH_LIFETIME_MS = 5 * 60 * 1000;
const MAX_WRITE_CHARS = 50_000;
const MAX_WRITE_BLOCKS = 200;
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const TYPE_NAMES = {
  doc: '旧版文档',
  docx: '新版文档',
  sheet: '电子表格',
  bitable: '多维表格',
  mindnote: '思维笔记',
  file: '文件',
  slides: '幻灯片',
  folder: '文件夹',
  shortcut: '快捷方式',
};

const TARGET_PATTERNS = [
  ['wiki', /\/wiki\/([A-Za-z0-9_-]{3,128})/],
  ['docx', /\/docx\/([A-Za-z0-9_-]{3,128})/],
  ['sheet', /\/sheets\/([A-Za-z0-9_-]{3,128})/],
  ['bitable', /\/base\/([A-Za-z0-9_-]{3,128})/],
  ['file', /\/file\/([A-Za-z0-9_-]{3,128})/],
  ['folder', /\/drive\/folder\/([A-Za-z0-9_-]{3,128})/],
];

function parameters(properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function registerTextTool(ctx, definition) {
  return ctx.tools.register({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: OUTPUT,
    execute: async (args, exec) => ({ text: await definition.execute(args, exec.signal) }),
  });
}

class FeishuError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function htmlPage(title, message, ok) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;max-width:620px;margin:12vh auto;padding:24px;color:#1f2329"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p style="color:#646a73">${ok ? '现在可以关闭此页面，返回 DeepSeek Harness。' : '请返回 DeepSeek Harness 后重试。'}</p></body></html>`;
}

/**
 * Accept either a bare Feishu token or a Feishu web URL, and report which kind
 * of resource the input points at. Bare tokens are reported as `token` so each
 * caller can decide what they mean.
 */
function parseTarget(value, allowed = ['wiki', 'docx', 'sheet', 'bitable', 'file', 'folder', 'token']) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) throw new Error('缺少飞书链接或 token。');
  if (/^https?:\/\//i.test(input)) {
    for (const [kind, pattern] of TARGET_PATTERNS) {
      const match = pattern.exec(input);
      if (match) {
        if (!allowed.includes(kind)) throw new Error(`此处不接受${TYPE_NAMES[kind] ?? kind}链接，请改用对应的工具。`);
        return { kind, token: match[1] };
      }
    }
    throw new Error('无法从链接中识别资源类型。支持 /docx/、/wiki/、/sheets/、/base/、/file/、/drive/folder/ 链接。');
  }
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(input)) {
    throw new Error('请输入飞书链接，或只包含字母、数字、下划线和连字符的 token。');
  }
  return { kind: 'token', token: input };
}

function requireInteger(value, label, min, max, fallback) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return result;
}

function isoTime(seconds) {
  if (!seconds) return undefined;
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function typeName(type) {
  return TYPE_NAMES[type] ?? type ?? '未知资源';
}

function columnName(index) {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cellText(cell) {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  if (Array.isArray(cell)) return cell.map(cellText).join('');
  if (typeof cell === 'object') {
    if (typeof cell.text === 'string') return cell.text;
    if (typeof cell.link === 'string') return cell.link;
    return JSON.stringify(cell);
  }
  return String(cell);
}

function safeFileName(name, fallback) {
  const base = String(name ?? '').replaceAll('\\', '/').split('/').pop() ?? '';
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function fileNameFromDisposition(header) {
  if (!header) return undefined;
  const starred = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (starred) {
    try {
      return decodeURIComponent(starred[1]);
    } catch {
      // fall through to the plain filename form
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || undefined;
}

async function availablePath(directory, name) {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 0; index < 100; index += 1) {
    const candidate = join(directory, index === 0 ? name : `${stem} (${index})${extension}`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('目标目录中存在过多同名文件，请换一个目录。');
}

function grantRecord(token, appId) {
  if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
    throw new Error('飞书令牌响应缺少 access_token。');
  }
  const now = Date.now();
  return {
    kind: 'grant',
    payload: {
      version: 1,
      appId,
      accessToken: token.access_token,
      accessTokenExpiresAt: now + Number(token.expires_in ?? 0) * 1000,
      ...(typeof token.refresh_token === 'string' && token.refresh_token.length > 0 ? {
        refreshToken: token.refresh_token,
        refreshTokenExpiresAt: now + Number(token.refresh_token_expires_in ?? 0) * 1000,
      } : {}),
      scope: typeof token.scope === 'string' ? token.scope : '',
    },
  };
}

function usableGrant(record, appId) {
  if (record?.kind !== 'grant') return undefined;
  const grant = record.payload;
  if (grant?.version !== 1 || grant.appId !== appId || typeof grant.accessToken !== 'string') return undefined;
  return grant;
}

export function apply(ctx, config = {}) {
  let pendingAuth;
  let lastAuth = { status: 'idle' };

  const closeAuth = () => {
    if (!pendingAuth) return;
    clearTimeout(pendingAuth.timer);
    pendingAuth.server.close();
    pendingAuth = undefined;
  };

  ctx.effect(() => () => closeAuth());

  const requestedScope = () => config.scope ?? DEFAULT_SCOPE;

  async function clientCredentials() {
    const appId = config.appId || (await ctx.credentials.resolve(config.appIdRef ?? 'FEISHU_APP_ID'))?.value;
    const appSecret = config.appSecret || (await ctx.credentials.resolve(config.appSecretRef ?? 'FEISHU_APP_SECRET'))?.value;
    if (!appId || !appSecret) {
      throw new Error('尚未配置飞书应用凭证。请在 Harness 凭据存储中设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET，或在插件 config 中设置 appId/appSecret。');
    }
    return { appId, appSecret };
  }

  async function fetchJson(url, options = {}) {
    const timeout = AbortSignal.timeout(20_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal,
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new FeishuError(`飞书返回了无法解析的响应（HTTP ${response.status}）。`, undefined, response.status);
    }
    if (!response.ok || (typeof data.code === 'number' && data.code !== 0)) {
      if (data.code === 99991679) {
        const missing = Array.isArray(data.error?.permission_violations)
          ? data.error.permission_violations.map((item) => item?.subject).filter(Boolean)
          : [];
        throw new FeishuError(
          `飞书请求失败（99991679）：缺少权限${missing.length > 0 ? ` ${missing.join('、')}` : ''}。请先在飞书开放平台为应用开通这些权限并发布版本，然后调用 feishu_auth 的 login 重新授权。`,
          data.code,
          response.status,
        );
      }
      const detail = data.msg || data.error_description || (typeof data.error === 'string' ? data.error : undefined) || response.statusText;
      throw new FeishuError(`飞书请求失败（${data.code ?? `HTTP ${response.status}`}）：${detail}`, data.code, response.status);
    }
    return data;
  }

  async function oauthToken(fields, signal) {
    const { appId, appSecret } = await clientCredentials();
    const body = new URLSearchParams({
      ...fields,
      client_id: appId,
      client_secret: appSecret,
    });
    return fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    });
  }

  async function accessToken(signal) {
    const { appId } = await clientCredentials();
    const record = await ctx.credentials.modifyRecord(CREDENTIAL_KEY, async (current) => {
      const grant = usableGrant(current, appId);
      if (!grant) throw new Error('尚未登录飞书。请先调用 feishu_auth，action 设为 login。');
      if (grant.accessTokenExpiresAt > Date.now() + 60_000) return current;
      if (grant.refreshToken && grant.refreshTokenExpiresAt > Date.now() + 60_000) {
        const token = await oauthToken({
          grant_type: 'refresh_token',
          refresh_token: grant.refreshToken,
        }, signal);
        return grantRecord(token, appId);
      }
      throw new Error('飞书登录已过期。请重新调用 feishu_auth，action 设为 login。');
    });
    return usableGrant(record, appId).accessToken;
  }

  async function api(path, options = {}) {
    const token = await accessToken(options.signal);
    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await fetchJson(url, {
          method: options.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: options.signal,
        });
        return result.data ?? result;
      } catch (error) {
        const retryable = error.status === 429 || error.code === 99991400;
        if (!retryable || attempt >= 2) throw error;
        await sleep(400 * (2 ** attempt), undefined, { signal: options.signal });
      }
    }
  }

  async function wikiNode(token, signal, objType = 'wiki') {
    const data = await api('/open-apis/wiki/v2/spaces/get_node', {
      query: { token, obj_type: objType },
      signal,
    });
    const node = data.node;
    if (!node?.obj_token) throw new FeishuError('知识库节点不存在，或当前账号无权访问。');
    return node;
  }

  function nodeSummary(node) {
    return {
      title: node.title,
      nodeToken: node.node_token,
      spaceId: node.space_id,
      objType: node.obj_type,
      objTypeName: typeName(node.obj_type),
      objToken: node.obj_token,
      ...(node.parent_node_token ? { parentNodeToken: node.parent_node_token } : {}),
      ...(node.node_type === 'shortcut' ? { shortcut: true, originNodeToken: node.origin_node_token } : {}),
      hasChild: Boolean(node.has_child),
      url: `https://feishu.cn/wiki/${node.node_token}`,
      ...(node.obj_edit_time ? { objEditedAt: isoTime(node.obj_edit_time) } : {}),
      ...(node.obj_create_time ? { objCreatedAt: isoTime(node.obj_create_time) } : {}),
    };
  }

  function typeMismatch(node, expected) {
    const hints = {
      sheet: '请改用 feishu_sheet_read，并传入这个知识库链接。',
      file: '请改用 feishu_file_download，并传入这个知识库链接。',
      docx: '请改用 feishu_doc_read，并传入这个知识库链接。',
      bitable: '当前版本不支持读写多维表格，可在飞书中直接打开。',
      doc: '当前版本不支持旧版文档，可在飞书中打开后另存为新版文档。',
      mindnote: '当前版本不支持思维笔记。',
      slides: '当前版本不支持幻灯片。',
    };
    return new FeishuError(
      `知识库节点「${node.title ?? node.node_token}」是${typeName(node.obj_type)}，不能按${expected}处理。${hints[node.obj_type] ?? ''}`,
    );
  }

  async function resolveDocx(target, signal) {
    const parsed = parseTarget(target, ['docx', 'wiki', 'token']);
    if (parsed.kind !== 'wiki') return { documentId: parsed.token };
    const node = await wikiNode(parsed.token, signal);
    if (node.obj_type !== 'docx') throw typeMismatch(node, '新版文档');
    return { documentId: node.obj_token, node };
  }

  async function resolveSpreadsheet(target, signal) {
    const parsed = parseTarget(target, ['sheet', 'wiki', 'token']);
    if (parsed.kind !== 'wiki') return { spreadsheetToken: parsed.token };
    const node = await wikiNode(parsed.token, signal);
    if (node.obj_type !== 'sheet') throw typeMismatch(node, '电子表格');
    return { spreadsheetToken: node.obj_token, node };
  }

  async function resolveFile(target, signal) {
    const parsed = parseTarget(target, ['file', 'wiki', 'docx', 'token']);
    if (parsed.kind !== 'wiki') return { fileToken: parsed.token };
    const node = await wikiNode(parsed.token, signal);
    if (node.obj_type !== 'file') throw typeMismatch(node, '文件下载');
    return { fileToken: node.obj_token, node };
  }

  async function beginLogin() {
    await clientCredentials();
    if (pendingAuth && Date.now() - pendingAuth.startedAt < AUTH_LIFETIME_MS) {
      return pendingAuth;
    }
    closeAuth();

    const { appId } = await clientCredentials();
    const port = requireInteger(config.callbackPort, 'callbackPort', 1024, 65535, 18923);
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const state = randomBytes(24).toString('base64url');

    const server = createServer((req, res) => {
      const respond = (title, message, ok, status = 200) => {
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(htmlPage(title, message, ok));
      };
      void (async () => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (req.method !== 'GET' || url.pathname !== '/oauth/callback') {
          respond('页面不存在', '请使用飞书授权后自动打开的回调地址。', false, 404);
          return;
        }
        if (!pendingAuth || url.searchParams.get('state') !== state) {
          respond('登录状态无效', 'state 校验失败或登录已过期，请重新发起登录。', false, 400);
          return;
        }
        if (url.searchParams.get('error')) {
          lastAuth = { status: 'denied', at: new Date().toISOString() };
          respond('已取消授权', '你拒绝了飞书授权，未保存任何登录令牌。', false);
          closeAuth();
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          respond('缺少授权码', '回调中没有 code 参数。', false, 400);
          return;
        }
        try {
          const token = await oauthToken({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
          });
          await ctx.credentials.modifyRecord(CREDENTIAL_KEY, () => grantRecord(token, appId));
          lastAuth = { status: 'authorized', at: new Date().toISOString() };
          respond('飞书登录成功', '现在可以浏览云盘、知识库，并读取文档和表格。', true);
        } catch (error) {
          lastAuth = { status: 'failed', at: new Date().toISOString(), error: errorMessage(error) };
          respond('飞书登录失败', errorMessage(error), false);
        } finally {
          closeAuth();
        }
      })().catch((error) => {
        lastAuth = { status: 'failed', at: new Date().toISOString(), error: errorMessage(error) };
        if (!res.headersSent) respond('飞书登录失败', errorMessage(error), false, 500);
        closeAuth();
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    }).catch((error) => {
      server.close();
      if (error?.code === 'EADDRINUSE') throw new Error(`OAuth 回调端口 ${port} 已被占用，请修改插件配置 callbackPort。`);
      throw error;
    });

    const authorizationUrl = new URL(AUTHORIZE_URL);
    authorizationUrl.search = new URLSearchParams({
      client_id: appId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: requestedScope(),
      state,
      prompt: 'consent',
    }).toString();

    pendingAuth = {
      server,
      state,
      redirectUri,
      authorizationUrl: authorizationUrl.toString(),
      startedAt: Date.now(),
      timer: undefined,
    };
    pendingAuth.timer = setTimeout(() => {
      lastAuth = { status: 'expired', at: new Date().toISOString() };
      closeAuth();
    }, AUTH_LIFETIME_MS);
    pendingAuth.timer.unref();
    lastAuth = { status: 'pending', at: new Date().toISOString() };
    return pendingAuth;
  }

  async function appendContent(id, content, signal) {
    if (typeof content !== 'string' || content.trim().length === 0) throw new Error('content 不能为空。');
    if (content.length > MAX_WRITE_CHARS) throw new Error(`content 最多 ${MAX_WRITE_CHARS} 个字符。`);
    const blocks = markdownToBlocks(content);
    if (blocks.length === 0) throw new Error('没有可写入的文本块。');
    if (blocks.length > MAX_WRITE_BLOCKS) throw new Error(`一次最多写入 ${MAX_WRITE_BLOCKS} 个文本块，请拆分内容。`);
    let batches = 0;
    for (let offset = 0; offset < blocks.length; offset += 50) {
      const children = blocks.slice(offset, offset + 50);
      await api(`/open-apis/docx/v1/documents/${id}/blocks/${id}/children`, {
        method: 'POST',
        query: { document_revision_id: -1, client_token: randomUUID() },
        body: { children },
        signal,
      });
      batches += 1;
      if (offset + 50 < blocks.length) await sleep(400, undefined, { signal });
    }
    return { blocks: blocks.length, batches };
  }

  registerTextTool(ctx, {
    name: 'feishu_auth',
    description: '管理飞书用户授权。login 返回浏览器登录链接并等待回调；status 查看配置、登录状态和已授权权限；logout 删除保存的令牌。浏览云盘或知识库前必须先登录。',
    parameters: parameters({
      action: { type: 'string', enum: ['login', 'status', 'logout'], description: '要执行的授权操作。' },
    }, ['action']),
    execute: async (args) => {
      if (args.action === 'login') {
        const auth = await beginLogin();
        return JSON.stringify({
          status: 'pending',
          authorizationUrl: auth.authorizationUrl,
          redirectUri: auth.redirectUri,
          requestedScope: requestedScope(),
          expiresInSeconds: 300,
          instruction: '请在浏览器打开 authorizationUrl 完成授权。回调地址必须已加入飞书应用的安全设置；完成后调用 feishu_auth 的 status。',
        }, null, 2);
      }
      if (args.action === 'logout') {
        closeAuth();
        await ctx.credentials.deleteRecord(CREDENTIAL_KEY);
        lastAuth = { status: 'logged-out', at: new Date().toISOString() };
        return '已退出飞书并删除本地保存的用户令牌。';
      }
      let appId;
      try {
        ({ appId } = await clientCredentials());
      } catch (error) {
        return JSON.stringify({ configured: false, signedIn: false, setup: errorMessage(error), lastAuth }, null, 2);
      }
      const grant = usableGrant(await ctx.credentials.readRecord(CREDENTIAL_KEY), appId);
      const granted = new Set((grant?.scope ?? '').split(/\s+/).filter(Boolean));
      const missingScopes = requestedScope().split(/\s+/).filter((scope) => scope && !granted.has(scope));
      return JSON.stringify({
        configured: true,
        signedIn: Boolean(grant),
        ...(grant ? {
          accessTokenExpiresAt: new Date(grant.accessTokenExpiresAt).toISOString(),
          canRefresh: Boolean(grant.refreshToken && grant.refreshTokenExpiresAt > Date.now()),
          scope: grant.scope,
          ...(missingScopes.length > 0 ? {
            missingScopes,
            note: '当前登录缺少上述权限，相关工具会返回权限错误。请重新执行 login 补授权。',
          } : {}),
        } : {}),
        pending: pendingAuth ? { authorizationUrl: pendingAuth.authorizationUrl, redirectUri: pendingAuth.redirectUri } : undefined,
        lastAuth,
      }, null, 2);
    },
  });

  registerTextTool(ctx, {
    name: 'feishu_drive_list',
    description: '列出飞书云空间（云盘）根目录或指定文件夹中的文件和文件夹，返回可用于后续读取的 token。知识库内容不在云盘中，请使用 feishu_wiki_spaces / feishu_wiki_nodes。',
    parameters: parameters({
      folder: { type: 'string', description: '文件夹 token 或包含 /drive/folder/ 的链接；省略表示云空间根目录。根目录不支持分页。' },
      page_token: { type: 'string', description: '上次结果返回的 nextPageToken。' },
      limit: { type: 'integer', description: '最多返回多少项，1–200，默认 50。' },
      order_by: { type: 'string', enum: ['EditedTime', 'CreatedTime'], description: '排序字段，默认按最近修改。' },
      direction: { type: 'string', enum: ['ASC', 'DESC'], description: '排序方向，默认 DESC。' },
    }),
    execute: async (args, signal) => {
      const limit = requireInteger(args.limit, 'limit', 1, 200, 50);
      const folder = args.folder?.trim() ? parseTarget(args.folder, ['folder', 'token']).token : undefined;
      const data = await api('/open-apis/drive/v1/files', {
        query: {
          folder_token: folder,
          page_token: args.page_token,
          page_size: limit,
          order_by: args.order_by ?? 'EditedTime',
          direction: args.direction ?? 'DESC',
        },
        signal,
      });
      const allFiles = data.files ?? [];
      const files = allFiles.slice(0, limit).map((file) => {
        const shortcut = file.type === 'shortcut' ? file.shortcut_info : undefined;
        return {
          name: file.name,
          type: shortcut?.target_type ?? file.type,
          token: shortcut?.target_token ?? file.token,
          ...(shortcut ? { shortcut: true, shortcutToken: file.token } : {}),
          url: file.url,
          ...(file.modified_time ? { modifiedAt: isoTime(file.modified_time) } : {}),
          ...(file.created_time ? { createdAt: isoTime(file.created_time) } : {}),
        };
      });
      return JSON.stringify({
        folderToken: folder ?? null,
        files,
        returned: files.length,
        omitted: allFiles.length - files.length,
        hasMore: Boolean(data.has_more),
        nextPageToken: data.next_page_token,
      }, null, 2);
    },
  });

  registerTextTool(ctx, {
    name: 'feishu_wiki_spaces',
    description: '列出当前用户有权访问的飞书知识库（Wiki 空间）。普通知识库会返回 space_id；「我的文档库」需要用 space_id=my_library 直接浏览，不会出现在列表中。',
    parameters: parameters({
      page_token: { type: 'string', description: '上次结果返回的 pageToken。' },
      limit: { type: 'integer', description: '最多返回多少个知识库，1–50，默认 20。' },
    }),
    execute: async (args, signal) => {
      const limit = requireInteger(args.limit, 'limit', 1, 50, 20);
      const data = await api('/open-apis/wiki/v2/spaces', {
        query: { page_size: limit, page_token: args.page_token },
        signal,
      });
      const items = (data.items ?? []).map((space) => ({
        name: space.name,
        spaceId: space.space_id,
        spaceType: space.space_type,
        visibility: space.visibility,
        ...(space.description ? { description: space.description } : {}),
        ...(space.open_sharing ? { openSharing: space.open_sharing } : {}),
      }));
      return JSON.stringify({
        spaces: items,
        returned: items.length,
        hasMore: Boolean(data.has_more),
        nextPageToken: data.page_token,
        hint: '要浏览「我的文档库」，调用 feishu_wiki_nodes 并令 space_id=my_library。',
      }, null, 2);
    },
  });

  registerTextTool(ctx, {
    name: 'feishu_wiki_nodes',
    description: '列出知识库某个节点下的子节点。省略 parent_node_token 时列出顶级节点；space_id 传 my_library 可浏览「我的文档库」。每个节点会返回 objType 和 objToken，可用 feishu_doc_read / feishu_sheet_read / feishu_file_download 读取。',
    parameters: parameters({
      space_id: { type: 'string', description: '知识库 space_id；「我的文档库」传 my_library。' },
      parent_node_token: { type: 'string', description: '父节点 token；省略表示顶级节点。' },
      page_token: { type: 'string', description: '上次结果返回的 pageToken。' },
      limit: { type: 'integer', description: '最多返回多少项，1–50，默认 20。' },
    }, ['space_id']),
    execute: async (args, signal) => {
      const spaceId = args.space_id.trim();
      if (!spaceId) throw new Error('space_id 不能为空。');
      const limit = requireInteger(args.limit, 'limit', 1, 50, 20);
      const data = await api(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
        query: {
          page_size: limit,
          page_token: args.page_token,
          parent_node_token: args.parent_node_token,
        },
        signal,
      });
      const nodes = (data.items ?? []).map(nodeSummary);
      return JSON.stringify({
        spaceId,
        parentNodeToken: args.parent_node_token ?? null,
        nodes,
        returned: nodes.length,
        hasMore: Boolean(data.has_more),
        nextPageToken: data.page_token,
      }, null, 2);
    },
  });

  registerTextTool(ctx, {
    name: 'feishu_wiki_node',
    description: '解析一个知识库链接或节点 token，返回它属于哪个知识库、对应哪种文档类型，以及可直接传给读取工具的信息。',
    parameters: parameters({
      token: { type: 'string', description: '知识库节点 token，或包含 /wiki/ 的链接。' },
      obj_type: {
        type: 'string',
        enum: ['wiki', 'docx', 'sheet', 'bitable', 'file', 'doc', 'mindnote', 'slides'],
        description: 'token 的实际类型；传节点 token 时保持默认 wiki。',
      },
    }, ['token']),
    execute: async (args, signal) => {
      const parsed = parseTarget(args.token, ['wiki', 'token']);
      const node = await wikiNode(parsed.token, signal, args.obj_type ?? 'wiki');
      return JSON.stringify(nodeSummary(node), null, 2);
    },
  });

  registerTextTool(ctx, {
    name: 'feishu_doc_read',
    description: '读取飞书新版文档（Docx）的纯文本内容。接受 /docx/ 链接、document_id，以及知识库中的新版文档链接（/wiki/<node_token>）。',
    parameters: parameters({
      document: { type: 'string', description: '文档链接或 document_id；也支持知识库中文档节点的链接。' },
      max_chars: { type: 'integer', description: '最多返回的正文字符数，500–200000，默认 20000。' },
    }, ['document']),
    execute: async (args, signal) => {
      const { documentId, node } = await resolveDocx(args.document, signal);
      const maxChars = requireInteger(args.max_chars, 'max_chars', 500, 200_000, 20_000);
      const data = await api(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`, { signal });
      const content = data.content ?? '';
      const truncated = content.length > maxChars;
      return JSON.stringify({
        documentId,
        ...(node ? { wikiNode: { nodeToken: node.node_token, spaceId: node.space_id, title: node.title }, title: node.title } : {}),
        totalCharacters: content.length,
        returnedCharacters: Math.min(content.length, maxChars),
        truncated,
        ...(truncated ? { note: `内容已截断，可增大 max_chars（上限 200000）或从文档开头之后继续读取。` } : {}),
        content: truncated ? content.slice(0, maxChars) : content,
      }, null, 2);
    },
  });

  registerTextTool(ctx, {
    name: 'feishu_doc_create',
    description: '在飞书云空间指定文件夹新建 Docx 文档，可同时写入初始正文。正文支持标题、列表、引用和代码块等简单 Markdown。新文档不能直接创建在知识库中。',
    parameters: parameters({
      title: { type: 'string', description: '文档标题，1–800 个字符。' },
      folder_token: { type: 'string', description: '目标文件夹 token；省略表示云空间根目录。' },
      content: { type: 'string', description: '可选初始正文；追加到新建文档中。' },
    }, ['title']),
    execute: async (args, signal) => {
      const title = args.title.trim();
      if (!title || title.length > 800) throw new Error('title 长度必须为 1–800 个字符。');
      const data = await api('/open-apis/docx/v1/documents', {
        method: 'POST',
        body: { title, folder_token: args.folder_token },
        signal,
      });
      const id = data.document?.document_id;
      if (!id) throw new Error('飞书创建文档后未返回 document_id。');
      let write;
      let writeError;
      if (args.content?.trim()) {
        try {
          write = await appendContent(id, args.content, signal);
        } catch (error) {
          writeError = errorMessage(error);
        }
      }
      return JSON.stringify({
        created: true,
        documentId: id,
        title: data.document.title || title,
        url: `https://feishu.cn/docx/${id}`,
        ...(write ? { appendedBlocks: write.blocks, batches: write.batches } : {}),
        ...(writeError ? { contentWriteFailed: writeError, note: '文档已经创建，可用该 documentId 重试追加，避免重复新建。' } : {}),
      }, null, 2);
    },
  });

  registerTextTool(ctx, {
    name: 'feishu_doc_append',
    description: '向飞书 Docx 文档末尾追加正文，不覆盖已有内容。支持标题、列表、引用和代码块等简单 Markdown。',
    parameters: parameters({
      document: { type: 'string', description: '文档链接或 document_id；也支持知识库中文档节点的链接。' },
      content: { type: 'string', description: '要追加的正文，最多 50000 字符、200 个文本块。' },
    }, ['document', 'content']),
    execute: async (args, signal) => {
      const { documentId } = await resolveDocx(args.document, signal);
      const result = await appendContent(documentId, args.content, signal);
      return JSON.stringify({
        appended: true,
        documentId,
        appendedBlocks: result.blocks,
        batches: result.batches,
        url: `https://feishu.cn/docx/${documentId}`,
      }, null, 2);
    },
  });

  registerTextTool(ctx, {
    name: 'feishu_sheet_read',
    description: '读取飞书电子表格（Sheet）的工作表列表和单元格内容。接受 /sheets/ 链接或 spreadsheet token，也支持知识库中的电子表格链接。默认读取第一个可见工作表的左上角区域，可用 sheet 和 range 精确指定。',
    parameters: parameters({
      spreadsheet: { type: 'string', description: '电子表格链接、spreadsheet token，或知识库中的表格链接。' },
      sheet: { type: 'string', description: '工作表名称或 sheet_id；省略时读取第一个可见工作表。' },
      range: { type: 'string', description: 'A1 记法区域，例如 A1:F20；省略时按 max_rows / max_cols 读取。' },
      max_rows: { type: 'integer', description: '未指定 range 时最多读取多少行，1–2000，默认 200。' },
      max_cols: { type: 'integer', description: '未指定 range 时最多读取多少列，1–100，默认 26。' },
    }, ['spreadsheet']),
    execute: async (args, signal) => {
      const { spreadsheetToken, node } = await resolveSpreadsheet(args.spreadsheet, signal);
      const maxRows = requireInteger(args.max_rows, 'max_rows', 1, 2000, 200);
      const maxCols = requireInteger(args.max_cols, 'max_cols', 1, 100, 26);

      const meta = await api(`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`, { signal });
      const sheets = (meta.sheets ?? []).filter((sheet) => sheet.resource_type !== 'bitable');
      if (sheets.length === 0) throw new FeishuError('该电子表格中没有可读取的工作表（可能全部是多维表格或不受支持的类型）。');

      const wanted = args.sheet?.trim();
      const current = wanted
        ? sheets.find((sheet) => sheet.sheet_id === wanted || sheet.title === wanted)
        : (sheets.find((sheet) => !sheet.hidden) ?? sheets[0]);
      if (!current) {
        throw new Error(`未找到工作表「${wanted}」。可用工作表：${sheets.map((sheet) => sheet.title).join('、')}。`);
      }

      const grid = current.grid_properties ?? {};
      const rowCount = Number(grid.row_count ?? maxRows);
      const colCount = Number(grid.column_count ?? maxCols);
      let range;
      if (args.range?.trim()) {
        const matched = /^(?:[^!]+!)?([A-Za-z]+[0-9]+)(?::([A-Za-z]+[0-9]+))?$/.exec(args.range.trim());
        if (!matched) throw new Error('range 需为 A1 记法，例如 A1:F20。');
        range = `${current.sheet_id}!${matched[1].toUpperCase()}:${(matched[2] ?? matched[1]).toUpperCase()}`;
      } else {
        if (rowCount < 1 || colCount < 1) throw new FeishuError(`工作表「${current.title}」为空。`);
        range = `${current.sheet_id}!A1:${columnName(Math.min(colCount, maxCols) - 1)}${Math.min(rowCount, maxRows)}`;
      }

      const data = await api(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${range}`, { signal });
      const valueRange = data.valueRange ?? data;
      const values = (valueRange.values ?? []).map((row) => (Array.isArray(row) ? row.map(cellText) : []));
      const truncatedRows = !args.range && rowCount > maxRows;
      const truncatedCols = !args.range && colCount > maxCols;

      return JSON.stringify({
        spreadsheetToken,
        ...(node ? { wikiNode: { nodeToken: node.node_token, spaceId: node.space_id, title: node.title } } : {}),
        sheet: {
          sheetId: current.sheet_id,
          title: current.title,
          rowCount,
          columnCount: colCount,
          hidden: Boolean(current.hidden),
        },
        availableSheets: sheets.map((sheet) => ({
          sheetId: sheet.sheet_id,
          title: sheet.title,
          hidden: Boolean(sheet.hidden),
        })),
        range,
        returnedRows: values.length,
        truncated: truncatedRows || truncatedCols,
        ...(truncatedRows || truncatedCols ? {
          note: `表格共有 ${rowCount} 行 × ${colCount} 列，本次只返回了左上角区域。可用 range 或增大 max_rows / max_cols 读取其余部分。`,
        } : {}),
        values,
      }, null, 2);
    },
  });

  registerTextTool(ctx, {
    name: 'feishu_file_download',
    description: '把飞书云盘或知识库中的二进制文件下载到本地目录，返回保存路径。适用于 drive 列表里 type=file 的文件；在线文档、电子表格和多维表格不能这样下载。',
    parameters: parameters({
      file: { type: 'string', description: '文件 token、包含 /file/ 的链接，或知识库中的文件节点链接。' },
      directory: { type: 'string', description: '保存目录，绝对路径或相对当前工作目录；默认用户主目录下的 feishu-downloads。' },
      max_bytes: { type: 'integer', description: '允许下载的最大字节数，1–524288000，默认 52428800（50 MB）。' },
    }, ['file']),
    execute: async (args, signal) => {
      const maxBytes = requireInteger(args.max_bytes, 'max_bytes', 1, 500 * 1024 * 1024, DEFAULT_MAX_DOWNLOAD_BYTES);
      const { fileToken, node } = await resolveFile(args.file, signal);

      const token = await accessToken(signal);
      const timeout = AbortSignal.timeout(120_000);
      const response = await fetch(new URL(`/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`, API_ORIGIN), {
        headers: { Authorization: `Bearer ${token}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let detail = text.slice(0, 300) || response.statusText;
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed.code === 'number') detail = `飞书请求失败（${parsed.code}）：${parsed.msg ?? ''}`;
        } catch {
          // keep the raw snippet
        }
        throw new FeishuError(detail, undefined, response.status);
      }

      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > maxBytes) {
        throw new FeishuError(`文件约 ${Math.ceil(declared / 1024 / 1024)} MB，超过 max_bytes 限制。请提高 max_bytes 后重试。`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw new FeishuError(`文件 ${Math.ceil(buffer.byteLength / 1024 / 1024)} MB，超过 max_bytes 限制。请提高 max_bytes 后重试。`);
      }

      const directory = args.directory?.trim()
        ? (isAbsolute(args.directory.trim()) ? args.directory.trim() : resolvePath(process.cwd(), args.directory.trim()))
        : join(homedir(), 'feishu-downloads');
      await mkdir(directory, { recursive: true });

      const suggested = fileNameFromDisposition(response.headers.get('content-disposition'));
      const name = safeFileName(suggested ?? node?.title ?? fileToken, `feishu-${fileToken}`);
      const target = await availablePath(directory, name);
      await writeFile(target, buffer);

      return JSON.stringify({
        saved: true,
        path: target,
        fileName: target.split(/[\\/]/).pop(),
        bytes: buffer.byteLength,
        contentType: response.headers.get('content-type') ?? undefined,
        fileToken,
        ...(node ? { wikiNode: { nodeToken: node.node_token, spaceId: node.space_id, title: node.title } } : {}),
      }, null, 2);
    },
  });
}
