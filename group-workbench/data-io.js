(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkbenchDataIO = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const HEADERS = {
    movie: ['影片名', '影片', '包名', '所属包', '影片名（包名）', '影片名(包名)', 'movie', 'package'],
    tid: ['tid', '任务tid', '任务id', 'caseid', 'case_id'],
    status: ['状态', '验收状态', '验收结果', 'status'],
    note: ['说明', '备注', '原因', '问题说明', 'note']
  };
  const ACCEPTANCE_STATUSES = ['待验收', '已送验收', '验收通过', '验收打回待修改'];

  function normalizeHeader(value) {
    return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
  }

  function headerIndex(headers, kind) {
    return headers.findIndex((header) => HEADERS[kind].includes(normalizeHeader(header)));
  }

  function delimiterFor(text) {
    let quoted = false;
    let commas = 0;
    let tabs = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"') {
        if (quoted && text[index + 1] === '"') index += 1;
        else quoted = !quoted;
      } else if (!quoted) {
        if (char === ',') commas += 1;
        if (char === '\t') tabs += 1;
        if (char === '\n' || char === '\r') {
          if (commas || tabs || text.slice(0, index).trim()) break;
        }
      }
    }
    return tabs > commas ? '\t' : ',';
  }

  // The first nonempty record is returned as headers, even for headerless input.
  // The higher-level parsers detect actual headers. Line numbers are physical,
  // one-based source lines, including when a quoted cell contains newlines.
  function parseTable(input) {
    const text = String(input == null ? '' : input).replace(/^\uFEFF/, '');
    const delimiter = delimiterFor(text);
    const records = [];
    let cells = [];
    let cell = '';
    let quoted = false;
    let closedQuote = false;
    let rowError = '';
    let line = 1;
    let recordLine = 1;

    function finishCell() {
      cells.push(cell);
      cell = '';
      closedQuote = false;
    }

    function finishRecord() {
      finishCell();
      if (cells.some((value) => value.trim()) || rowError) {
        records.push({ line: recordLine, cells, error: rowError || undefined });
      }
      cells = [];
      rowError = '';
    }

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            cell += '"';
            index += 1;
          } else {
            quoted = false;
            closedQuote = true;
          }
        } else if (char === '\r' || char === '\n') {
          cell += char;
          if (char === '\r' && text[index + 1] === '\n') {
            cell += '\n';
            index += 1;
          }
          line += 1;
        } else cell += char;
      } else if (char === delimiter) {
        finishCell();
      } else if (char === '\r' || char === '\n') {
        finishRecord();
        if (char === '\r' && text[index + 1] === '\n') index += 1;
        line += 1;
        recordLine = line;
      } else if (char === '"') {
        if (!closedQuote && !cell.trim()) {
          cell = '';
          quoted = true;
        } else {
          cell += char;
          rowError = rowError || '引号格式错误，请使用成对双引号包裹字段。';
        }
      } else if (closedQuote) {
        if (!/\s/.test(char)) {
          cell += char;
          rowError = rowError || '引号字段后存在多余内容。';
        }
      } else cell += char;
    }
    if (quoted) rowError = rowError || '双引号未闭合。';
    if (cell || cells.length || rowError || closedQuote) finishRecord();
    return {
      headers: records.length ? records[0].cells.slice() : [],
      rows: records.slice(1).map((record) => record.cells.slice()),
      records,
      delimiter
    };
  }

  function validateTid(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  }

  // Subsequent workflow steps accept existing TIDs only. Never split a pasted
  // movie/status column, comma list, or quoted multiline field into new tasks.
  // This pure parser does not resolve whether a TID exists or can be processed;
  // callers must check every error-free row against the latest task store.
  function parseTidRows(input) {
    const text = String(input == null ? '' : input).replace(/^\uFEFF/, '');
    const physicalLines = text.split(/\r\n|\r|\n/);
    const records = parseTable(text).records.map(record => ({ ...record, cells: record.cells.slice() }));
    const covered = new Set();
    for (const record of records) {
      record.lineEnd = record.line + record.cells.reduce((count, cell) => count + (cell.match(/\r\n|\r|\n/g) || []).length, 0);
      for (let line = record.line; line <= record.lineEnd; line += 1) covered.add(line);
    }
    // parseTable intentionally omits empty CSV rows for its older consumers.
    // Here a visible row such as `,` or `""` must receive a result, not disappear.
    physicalLines.forEach((value, index) => {
      const line = index + 1;
      if (value.trim() && !covered.has(line)) records.push({ line, lineEnd: line, cells: [value], emptyRecord: true });
    });
    records.sort((left, right) => left.line - right.line);
    const seen = new Map();
    const result = [];
    records.forEach((record, index) => {
      const cells = record.cells.map(value => value.trim());
      const tid = cells.length === 1 ? cells[0] : cells.join('\t');
      const original = physicalLines.slice(record.line - 1, record.lineEnd).join('\n');
      const normalized = normalizeHeader(tid);
      const multipleColumns = cells.length !== 1 || record.cells.some(value => /[\t,，;；]/.test(value));
      if (index === 0 && !record.error && !record.emptyRecord && record.lineEnd === record.line && !multipleColumns && HEADERS.tid.includes(normalized)) return;
      let error = record.error || '', code = error ? 'INVALID_QUOTING' : '';
      if (!error && record.lineEnd !== record.line) { error = '一条 TID 不能跨多行，请核对这一整段内容；没有拆分为任务。'; code = 'MULTILINE_VALUE'; }
      if (!error && multipleColumns) { error = '每行只能填写一条 TID，请删除影片、状态等多余列；多个 TID 请换行填写。'; code = 'MULTIPLE_COLUMNS'; }
      if (!error && record.emptyRecord) { error = '这一行缺少 TID。'; code = 'EMPTY_TID'; }
      if (!error && index === 0 && ['movie', 'status', 'note'].some(kind => HEADERS[kind].includes(normalized))) { error = '这里只能粘贴 TID 一列，不能使用影片、状态或说明列。'; code = 'WRONG_HEADER'; }
      if (!error && !validateTid(tid)) { error = /\s/.test(tid) ? '一行只能填写一条完整 TID，不能用空格分隔多个编号。' : 'TID 必须为 1–128 位字母、数字、下划线或连字符。'; code = 'INVALID_TID'; }
      const key = tid.toUpperCase(), firstLine = seen.get(key);
      if (!error && firstLine !== undefined) { error = `TID 重复，与第 ${firstLine} 行相同（不区分大小写），本行不会再次处理。`; code = 'DUPLICATE_TID'; }
      if (!error) seen.set(key, record.line);
      const structureError = ['INVALID_QUOTING', 'MULTILINE_VALUE', 'MULTIPLE_COLUMNS', 'WRONG_HEADER'].includes(code) || (code === 'INVALID_TID' && /\s/.test(tid));
      const row = { line: record.line, tid, structureError };
      if (error) Object.assign(row, { error, code, input: original });
      if (record.lineEnd !== record.line) row.lineEnd = record.lineEnd;
      if (code === 'DUPLICATE_TID') row.duplicateOf = firstLine;
      result.push(row);
    });
    return result;
  }

  function parseTaskRows(text, defaultMovie) {
    const table = parseTable(text);
    if (!table.records.length) return [];
    const movieIndex = headerIndex(table.headers, 'movie');
    const tidIndex = headerIndex(table.headers, 'tid');
    const hasHeader = movieIndex !== -1 || tidIndex !== -1;
    const fallbackMovie = String(defaultMovie == null ? '' : defaultMovie).trim();
    if (hasHeader && tidIndex === -1) {
      return [{ line: table.records[0].line, movie: '', tid: '', error: '表头缺少 TID 列。' }];
    }
    if (hasHeader && table.records[0].error) {
      return [{ line: table.records[0].line, movie: '', tid: '', error: table.records[0].error }];
    }
    return table.records.slice(hasHeader ? 1 : 0).map((record) => {
      const cells = record.cells.map((value) => value.trim());
      const singleTid = !hasHeader && cells.length === 1;
      const movie = (hasHeader ? (movieIndex === -1 ? '' : cells[movieIndex]) : (singleTid ? '' : cells[0])) || fallbackMovie;
      const tid = (hasHeader ? cells[tidIndex] : cells[singleTid ? 0 : 1]) || '';
      let error = record.error;
      if (!error && !hasHeader && cells.length > 2) error = '无表头时每行只填写影片名、TID 两列。';
      if (!error && !movie) error = '缺少影片名（包名），请在该行填写或设置默认影片名。';
      if (!error && !validateTid(tid)) error = 'TID 必须为 1–128 位字母、数字、下划线或连字符。';
      return Object.assign({ line: record.line, movie, tid }, error ? { error } : {});
    });
  }

  function parseAcceptanceRows(text) {
    const table = parseTable(text);
    if (!table.records.length) return [];
    const tidIndex = headerIndex(table.headers, 'tid');
    const statusIndex = headerIndex(table.headers, 'status');
    const noteIndex = headerIndex(table.headers, 'note');
    const hasHeader = tidIndex !== -1 || statusIndex !== -1 || noteIndex !== -1;
    if (hasHeader && (tidIndex === -1 || statusIndex === -1 || table.records[0].error)) {
      return [{ line: table.records[0].line, tid: '', status: '', note: '', error: table.records[0].error || '表头必须同时包含 TID 和状态列。' }];
    }
    return table.records.slice(hasHeader ? 1 : 0).map((record) => {
      const cells = record.cells.map((value) => value.trim());
      const tid = cells[hasHeader ? tidIndex : 0] || '';
      const status = cells[hasHeader ? statusIndex : 1] || '';
      const note = (hasHeader ? (noteIndex === -1 ? '' : cells[noteIndex]) : cells[2]) || '';
      let error = record.error;
      if (!error && !hasHeader && cells.length > 3) error = '无表头时每行只填写 TID、状态、说明三列。';
      if (!error && !validateTid(tid)) error = 'TID 必须为 1–128 位字母、数字、下划线或连字符。';
      if (!error && !ACCEPTANCE_STATUSES.includes(status)) error = `不支持的验收状态，请使用：${ACCEPTANCE_STATUSES.join('、')}。`;
      return Object.assign({ line: record.line, tid, status, note }, error ? { error } : {});
    });
  }

  function csv(columns, rows) {
    const descriptors = columns.map((column) => typeof column === 'string' ? { key: column, label: column } : column);
    function safeCell(value) {
      let text = String(value == null ? '' : value);
      // CSV quoting alone does not prevent formula execution in spreadsheet apps.
      if (/^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    }
    const lines = [descriptors.map((column) => safeCell(column.label == null ? column.key : column.label)).join(',')];
    rows.forEach((row) => {
      lines.push(descriptors.map((column, index) => safeCell(Array.isArray(row) ? row[index] : row[column.key])).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function summaryRows(tasks, statusMeta, groupLabel) {
    const statuses = Object.keys(statusMeta || {});
    const groups = new Map();
    (tasks || []).forEach((task) => {
      const movie = String(task.movie || '未填写影片名');
      const groupId = String(task.groupId || '');
      const key = JSON.stringify([movie, groupId]);
      if (!groups.has(key)) {
        const row = {
          movie, groupId,
          group: typeof groupLabel === 'function' ? groupLabel(groupId) : groupId,
          total: 0, rejectionPending: 0, rejected: 0
        };
        statuses.forEach((status) => { row[status] = 0; });
        groups.set(key, row);
      }
      const row = groups.get(key);
      const status = String(task.status || '');
      row.total += 1;
      if (Object.prototype.hasOwnProperty.call(row, status) && statuses.includes(status)) row[status] += 1;
      else if (status) row[status] = (row[status] || 0) + 1;
      const label = statusMeta && statusMeta[status] && statusMeta[status].label || status;
      const pending = /reject.*pending|pending.*reject|reject.*review|rejection.*pending/i.test(status) || (/拒绝/.test(label) && /待|确认中/.test(label));
      const confirmed = /^(rejected|rejection_confirmed|reject_confirmed|confirmed_rejected)$/.test(status) || (/拒绝/.test(label) && /确认|已拒绝|终止/.test(label) && !pending);
      // An exact matching status has already incremented its metric above.
      if (pending && status !== 'rejectionPending') row.rejectionPending += 1;
      if (confirmed && status !== 'rejected') row.rejected += 1;
    });
    return Array.from(groups.values()).sort((left, right) => left.movie.localeCompare(right.movie, 'zh-CN') || left.groupId.localeCompare(right.groupId));
  }

  return Object.freeze({ parseTable, parseTidRows, parseTaskRows, validateTid, parseAcceptanceRows, csv, summaryRows });
}));
