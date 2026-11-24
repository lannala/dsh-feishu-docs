import { apply } from './index.js';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_ID = 'cli_test';
const GRANT = {
  kind: 'grant',
  payload: {
    version: 1,
    appId: APP_ID,
    accessToken: 'user-access-token',
    accessTokenExpiresAt: Date.now() + 3_600_000,
    refreshToken: 'refresh',
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    scope: 'offline_access drive:drive:readonly wiki:wiki:readonly docx:document sheets:spreadsheet:readonly',
  },
};

const tools = new Map();
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
  credentials: {
    async resolve(ref) { return { value: ref === 'FEISHU_APP_ID' ? APP_ID : 'secret' }; },
    async readRecord() { return GRANT; },
    async modifyRecord(_key, fn) { return fn(GRANT); },
    async deleteRecord() {},
  },
  effect(fn) { return fn(); },
};

const calls = [];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  calls.push({ url: url.toString(), method: options.method ?? 'GET' });
  const path = url.pathname;
  const auth = options.headers?.Authorization;
  if (auth !== 'Bearer user-access-token') throw new Error(`missing bearer: ${auth}`);

  if (path === '/open-apis/drive/v1/files') {
    if (url.searchParams.get('folder_token') !== 'fldcnFolder') throw new Error(`bad folder_token: ${url.search}`);
    return json({ code: 0, data: { files: [
      { name: '季度报告', type: 'docx', token: 'doxcnDoc', url: 'https://x.feishu.cn/docx/doxcnDoc', modified_time: '1700000000' },
      { name: '快捷方式', type: 'shortcut', token: 'scToken', shortcut_info: { target_type: 'sheet', target_token: 'shtcnS' } },
    ], has_more: false } });
  }
  if (path === '/open-apis/wiki/v2/spaces') {
    return json({ code: 0, data: { items: [{ name: '团队知识库', space_id: 'sp1', space_type: 'team', visibility: 'private' }], has_more: false } });
  }
  if (path === '/open-apis/wiki/v2/spaces/my_library/nodes') {
    return json({ code: 0, data: { items: [
      { space_id: 'my_library', node_token: 'wikcnDoc', obj_token: 'doxcnDoc', obj_type: 'docx', title: '我的文档', has_child: true, node_type: 'origin' },
    ], has_more: false } });
  }
  if (path === '/open-apis/wiki/v2/spaces/get_node') {
    const token = url.searchParams.get('token');
    if (token === 'wikcnSheet') {
      return json({ code: 0, data: { node: { space_id: 'sp1', node_token: 'wikcnSheet', obj_token: 'shtcnS', obj_type: 'sheet', title: '预算表', has_child: false } } });
    }
    if (token === 'wikcnDoc') {
      return json({ code: 0, data: { node: { space_id: 'my_library', node_token: 'wikcnDoc', obj_token: 'doxcnDoc', obj_type: 'docx', title: '我的文档', has_child: false } } });
    }
    return json({ code: 131006, msg: 'node not found' });
  }
  if (path === '/open-apis/docx/v1/documents/doxcnDoc/raw_content') {
    return json({ code: 0, data: { content: '正文内容' } });
  }
  if (path === '/open-apis/sheets/v3/spreadsheets/shtcnS/sheets/query') {
    return json({ code: 0, data: { sheets: [
      { sheet_id: 'sheet1', title: '汇总', index: 0, hidden: false, resource_type: 'sheet', grid_properties: { row_count: 5, column_count: 4 } },
      { sheet_id: 'sheet2', title: '明细', index: 1, hidden: false, resource_type: 'sheet', grid_properties: { row_count: 3, column_count: 2 } },
    ] } });
  }
  if (path === '/open-apis/sheets/v2/spreadsheets/shtcnS/values/sheet1!A1:C2') {
    return json({ code: 0, data: { valueRange: { values: [
      [{ type: 'text', text: '名称' }, '数量', { text: '备注' }],
      ['A', 12, null],
    ] } } });
  }
  if (path === '/open-apis/drive/v1/files/filecnF/download') {
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"' },
    });
  }
  return json({ code: 404, msg: `unmocked ${path}` });
};

apply(ctx, {});
const run = (name, args) => tools.get(name).execute(args, { signal: undefined });

const results = [];
const check = (label, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${detail}` : ''}`);

const drive = JSON.parse((await run('feishu_drive_list', { folder: 'https://acme.feishu.cn/drive/folder/fldcnFolder' })).text);
check('drive folder url -> folder_token', drive.files.length === 2 && drive.files[1].token === 'shtcnS' && drive.files[1].type === 'sheet', JSON.stringify(drive.files[1]));

const spaces = JSON.parse((await run('feishu_wiki_spaces', {})).text);
check('wiki spaces', spaces.spaces[0].spaceId === 'sp1');

const nodes = JSON.parse((await run('feishu_wiki_nodes', { space_id: 'my_library' })).text);
check('my_library nodes', nodes.nodes[0].objToken === 'doxcnDoc' && nodes.nodes[0].url === 'https://feishu.cn/wiki/wikcnDoc');

const node = JSON.parse((await run('feishu_wiki_node', { token: 'https://acme.feishu.cn/wiki/wikcnSheet' })).text);
check('wiki node resolve via url', node.objType === 'sheet' && node.objToken === 'shtcnS', node.objType);

const doc = JSON.parse((await run('feishu_doc_read', { document: 'https://acme.feishu.cn/wiki/wikcnDoc' })).text);
check('doc read through wiki link', doc.content === '正文内容' && doc.title === '我的文档', doc.content);

let sheetError = '';
try {
  await run('feishu_doc_read', { document: 'https://acme.feishu.cn/wiki/wikcnSheet' });
} catch (error) {
  sheetError = error.message;
}
check('doc read on sheet node explains alternative', sheetError.includes('feishu_sheet_read'), sheetError);

const sheet = JSON.parse((await run('feishu_sheet_read', { spreadsheet: 'https://acme.feishu.cn/wiki/wikcnSheet', max_rows: 2, max_cols: 3 })).text);
check('sheet range clamp', sheet.range === 'sheet1!A1:C2', sheet.range);
check('sheet values flatten', sheet.values[0][0] === '名称' && sheet.values[1][1] === '12' && sheet.values[1][2] === '', JSON.stringify(sheet.values));
check('sheet truncation note', sheet.truncated === true && sheet.sheet.rowCount === 5);

const directory = join(tmpdir(), `feishu-test-${Date.now()}`);
const download = JSON.parse((await run('feishu_file_download', { file: 'filecnF', directory })).text);
const bytes = await readFile(download.path);
check('file download', bytes.length === 4 && download.fileName === 'report.pdf', download.path);
await rm(directory, { recursive: true, force: true });

console.log(results.join('\n'));
console.log(`\nrequests: ${calls.length}`);
if (results.some((line) => line.startsWith('FAIL'))) process.exit(1);
