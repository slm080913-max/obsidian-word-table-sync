const {
  Plugin,
  TFile,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownView,
  ItemView
} = require("obsidian");

const VIEW_TYPE_WORD_REVIEW = "word-table-sync-review";

const DEFAULT_SETTINGS = {
  sourcePath: "英语陌生单词表.md",
  plainPath: "单词查看.md",
  masteredPath: "已背诵单词表.md",
  statePath: "word-review-state.json",
  separator: ", ",
  reviewIntervals: "1,1,4,7,16",
  reviewGraceDays: "0,0,0,1,1,2",
  autoSync: true,
  autoMoveMastered: true,
  autoReactivate: true
};

function normalizePath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function todayString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseNumbers(text, fallback, min) {
  const nums = String(text || "")
    .split(",")
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value >= min);
  return nums.length ? nums : fallback.slice();
}

function parseIntervals(text) {
  return parseNumbers(text, [1, 1, 4, 7, 16], 1);
}

function parseGraceDays(text) {
  return parseNumbers(text, [0, 0, 0, 1, 1, 2], 0);
}

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function splitMarkdownRow(row) {
  let s = String(row || "").trim();
  if (!s.startsWith("|")) return [];
  if (s.endsWith("|")) s = s.slice(0, -1);
  s = s.slice(1);

  const cells = [];
  let buf = "";
  let escaped = false;

  for (const ch of s) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }

  cells.push(buf.trim());
  return cells;
}

function isSeparatorRow(row) {
  const cells = splitMarkdownRow(row);
  return cells.length > 0 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function isBinaryCode(value) {
  return /^[01]+$/.test(String(value || "").trim());
}

function getIdentity(cells) {
  // Word + part-of-speech is the identity. This prevents two entries such as
  // "record / n" and "record / v" from being merged.
  return cells
    .slice(0, 2)
    .map(cell => String(cell).replace(/\s+/g, " ").trim().toLowerCase())
    .join("\u001f");
}

function isMastered(code) {
  const value = String(code || "").trim();
  // Existing notes may use short codes. Only a 7th bit set to 1 means v=1.
  return isBinaryCode(value) && value.length >= 7 && value[6] === "1";
}

function getCompletedStage(code) {
  const value = String(code || "").trim();
  if (!isBinaryCode(value)) return 0;

  let stage = 0;
  for (let i = 0; i < Math.min(value.length, 6); i++) {
    if (value[i] !== "1") break;
    stage++;
  }
  return stage;
}

function advanceReviewCode(code) {
  const value = String(code || "").trim();
  if (!value) return { code: "1", stage: 1 };
  if (!isBinaryCode(value)) return null;

  // User-facing progress codes are intentionally simple:
  // 1 → 11 → 111 → 1111 → 11111 → 111111.
  // The 7th bit is v and is never written automatically by the review button.
  // Therefore the review button stops after the six scheduled review bits.
  if (getCompletedStage(value) >= 6) return null;

  const chars = value.split("");
  const zeroIndex = chars.indexOf("0");
  if (zeroIndex >= 0) {
    chars[zeroIndex] = "1";
  } else {
    chars.push("1");
  }

  const nextCode = chars.join("");
  return {
    code: nextCode,
    stage: getCompletedStage(nextCode)
  };
}

function getGapAfterStage(stage, intervals) {
  const s = Number(stage || 0);
  if (s <= 0 || s >= 6) return null;
  return intervals[Math.min(s - 1, intervals.length - 1)] ?? intervals[intervals.length - 1] ?? 1;
}

function getGraceForTargetStage(stage, graceText) {
  const grace = parseGraceDays(graceText);
  const targetStage = Math.max(1, Math.min(Number(stage || 1), 6));
  return grace[Math.min(targetStage - 1, grace.length - 1)] ?? 0;
}

function getReviewWindow(nextReviewDate, targetStage, graceText) {
  if (!nextReviewDate) return null;
  const grace = getGraceForTargetStage(targetStage, graceText);
  return {
    target: nextReviewDate,
    start: addDays(nextReviewDate, -grace),
    end: addDays(nextReviewDate, grace),
    grace
  };
}

function classifyDueDate(nextReviewDate, targetStage, graceText, today = todayString()) {
  const window = getReviewWindow(nextReviewDate, targetStage, graceText);
  if (!window) return "none";
  if (today < window.start) return "future";
  if (today > window.end) return "overdue";
  return "today";
}

class WordTableSyncPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.syncing = false;
    this.timer = null;
    this.ignorePaths = new Set();
    this.state = await this.loadState();
    this.reviewView = null;

    this.registerView(VIEW_TYPE_WORD_REVIEW, leaf => {
      this.reviewView = new WordReviewView(leaf, this);
      return this.reviewView;
    });

    this.addRibbonIcon("calendar-check", "打开单词复习", () => this.activateReviewView());

    this.addCommand({
      id: "open-word-review-sidebar",
      name: "打开单词复习侧边栏",
      callback: () => this.activateReviewView()
    });

    this.addCommand({
      id: "sync-word-table",
      name: "同步单词表",
      callback: () => this.sync("manual")
    });

    this.addCommand({
      id: "record-current-word-review",
      name: "记录当前单词复习",
      checkCallback: checking => {
        const info = this.getCurrentTableRow();
        if (checking) return !!info;
        if (info) this.recordReview(info);
      }
    });

    this.addCommand({
      id: "complete-all-due-reviews",
      name: "一键完成全部到期复习",
      checkCallback: checking => {
        const due = this.getDueEntries();
        if (checking) return due.length > 0;
        if (due.length) this.completeDueReviews();
      }
    });

    this.addCommand({
      id: "show-current-word-review-info",
      name: "查看当前单词复习日期",
      checkCallback: checking => {
        const info = this.getCurrentTableRow();
        if (checking) return !!info;
        if (info) this.showReviewInfo(info);
      }
    });

    this.addSettingTab(new WordTableSyncSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("modify", file => {
      if (!(file instanceof TFile)) return;
      const path = normalizePath(file.path);

      if (this.ignorePaths.has(path)) {
        this.ignorePaths.delete(path);
        return;
      }

      if (
        path === normalizePath(this.settings.sourcePath) ||
        path === normalizePath(this.settings.masteredPath) ||
        path === normalizePath(this.settings.plainPath)
      ) {
        if (this.settings.autoSync) this.scheduleSync();
      }
    }));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoSync) this.scheduleSync(250);
    });
  }

  onunload() {
    clearTimeout(this.timer);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_WORD_REVIEW);
  }

  async activateReviewView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORD_REVIEW)[0];

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
      if (!leaf) {
        new Notice("无法打开单词复习面板。");
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_WORD_REVIEW, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
    this.refreshReviewView();
  }

  refreshReviewView() {
    if (this.reviewView && typeof this.reviewView.refresh === "function") {
      this.reviewView.refresh();
    }
  }

  scheduleSync(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync("auto"), delay);
  }

  async loadState() {
    const path = normalizePath(this.settings.statePath);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { version: 1, words: {} };

    try {
      const json = JSON.parse(await this.app.vault.read(file));
      if (!json || typeof json !== "object") return { version: 1, words: {} };
      if (!json.words || typeof json.words !== "object") json.words = {};
      return json;
    } catch (error) {
      console.error("Word Table Sync state parse error", error);
      return { version: 1, words: {} };
    }
  }

  async saveState() {
    const content = JSON.stringify(this.state, null, 2);
    await this.writeTextFile(this.settings.statePath, content, true);
  }

  findBestTable(content) {
    const lines = String(content || "").split("\n");
    let best = null;

    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].trim().startsWith("|") || !isSeparatorRow(lines[i + 1])) continue;

      const headers = splitMarkdownRow(lines[i]).map(header => header.trim().toLowerCase());
      if (!headers.length) continue;

      let score = 0;
      if (headers[0] === "单词" || headers[0] === "word") score += 5;
      if (headers.some(h => h.includes("词性") || h.includes("part of speech") || h === "pos")) score += 2;
      if (headers.some(h => h.includes("意思") || h.includes("释义") || h === "meaning" || h === "definition")) score += 2;
      if (headers.some(h => /day|复习|review|v/i.test(h))) score += 3;
      if (headers.some(h => /day1[-–]?2[-–]?3[-–]?7[-–]?14[-–]?30[-–]?v/i.test(h.replace(/\s+/g, "")))) score += 4;

      let end = i + 2;
      let binaryCount = 0;
      while (end < lines.length && lines[end].trim().startsWith("|")) {
        const cells = splitMarkdownRow(lines[end]);
        const codeCell = cells[cells.length - 1];
        if (cells.length === headers.length && isBinaryCode(codeCell)) binaryCount++;
        end++;
      }
      score += Math.min(binaryCount, 8);

      if (!best || score > best.score) {
        best = {
          score,
          lines,
          headerIndex: i,
          separatorIndex: i + 1,
          endIndex: end,
          headers,
          rowCount: end - (i + 2)
        };
      }
    }

    return best;
  }

  parseTable(content) {
    const table = this.findBestTable(content);
    if (!table) return null;
    const rows = table.lines
      .slice(table.separatorIndex + 1, table.endIndex)
      .filter(line => line.trim().startsWith("|"));
    return { ...table, rows };
  }

  async sync(reason = "auto") {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const sourcePath = normalizePath(this.settings.sourcePath);
      const masteredPath = normalizePath(this.settings.masteredPath);
      const plainPath = normalizePath(this.settings.plainPath);

      const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(sourceFile instanceof TFile)) {
        if (reason === "manual") new Notice(`找不到单词表：${sourcePath}`);
        return;
      }

      const sourceContent = await this.app.vault.read(sourceFile);
      const sourceTable = this.parseTable(sourceContent);
      if (!sourceTable) {
        if (reason === "manual") new Notice("没有识别到符合条件的 Markdown 单词表。");
        return;
      }

      const masteredFile = this.app.vault.getAbstractFileByPath(masteredPath);
      let masteredContent = "";
      let masteredTable = null;
      if (masteredFile instanceof TFile) {
        masteredContent = await this.app.vault.read(masteredFile);
        masteredTable = this.parseTable(masteredContent);
      }

      const sourceEntries = new Map();
      const archiveEntries = new Map();
      const sourcePassthrough = [];
      const archivePassthrough = [];

      for (const row of sourceTable.rows) {
        const cells = splitMarkdownRow(row);
        if (cells.length !== sourceTable.headers.length) {
          sourcePassthrough.push(row);
          continue;
        }

        const word = cells[0]?.trim();
        const code = cells[cells.length - 1]?.trim();
        if (!word || !isBinaryCode(code)) {
          sourcePassthrough.push(row);
          continue;
        }

        sourceEntries.set(getIdentity(cells), { row, cells, code });
      }

      if (masteredTable) {
        for (const row of masteredTable.rows) {
          const cells = splitMarkdownRow(row);
          if (cells.length !== masteredTable.headers.length) {
            archivePassthrough.push(row);
            continue;
          }

          const word = cells[0]?.trim();
          const code = cells[cells.length - 1]?.trim();
          if (!word || !isBinaryCode(code)) {
            archivePassthrough.push(row);
            continue;
          }

          archiveEntries.set(getIdentity(cells), { row, cells, code });
        }
      }

      const activeRows = [];
      const masteredRows = [];
      const activeIds = new Set();
      const masteredIds = new Set();

      for (const [id, item] of sourceEntries) {
        if (this.settings.autoMoveMastered && isMastered(item.code)) {
          if (!masteredIds.has(id)) {
            masteredRows.push(item.row);
            masteredIds.add(id);
          }
        } else if (!activeIds.has(id)) {
          activeRows.push(item.row);
          activeIds.add(id);
        }
      }

      for (const [id, item] of archiveEntries) {
        // If the same word exists in the source, the source is authoritative.
        if (sourceEntries.has(id)) continue;

        if (this.settings.autoReactivate && !isMastered(item.code)) {
          if (!activeIds.has(id)) {
            activeRows.push(item.row);
            activeIds.add(id);
          }
        } else if (!masteredIds.has(id)) {
          masteredRows.push(item.row);
          masteredIds.add(id);
        }
      }

      activeRows.push(...sourcePassthrough);
      masteredRows.push(...archivePassthrough);

      const sourceHeader = sourceTable.lines[sourceTable.headerIndex];
      const sourceSeparator = sourceTable.lines[sourceTable.separatorIndex];
      const archiveHeader = masteredTable
        ? masteredTable.lines[masteredTable.headerIndex]
        : sourceHeader;
      const archiveSeparator = masteredTable
        ? masteredTable.lines[masteredTable.separatorIndex]
        : sourceSeparator;

      const newSourceContent = this.replaceTableRows(sourceContent, sourceTable, activeRows);
      if (newSourceContent !== sourceContent) {
        await this.writeTextFile(sourcePath, newSourceContent);
      }

      let newMasteredContent;
      if (masteredTable) {
        newMasteredContent = this.replaceTableRows(masteredContent, masteredTable, masteredRows);
      } else if (masteredRows.length) {
        newMasteredContent = `${archiveHeader}\n${archiveSeparator}\n${masteredRows.join("\n")}\n`;
      } else {
        newMasteredContent = `# 已背诵单词表\n\n${archiveHeader}\n${archiveSeparator}\n`;
      }

      if (newMasteredContent !== masteredContent || !(masteredFile instanceof TFile)) {
        await this.writeTextFile(masteredPath, newMasteredContent);
      }

      const plainWords = activeRows
        .map(row => splitMarkdownRow(row)[0]?.trim())
        .filter(Boolean);

      const sourceEmbedName = sourcePath.replace(/\.md$/i, "");
      const plainText = [
        plainWords.join(this.settings.separator),
        `![[${sourceEmbedName}]]`
      ].join("\n");

      await this.writeTextFile(plainPath, plainText);

      this.syncStateFromTables(activeRows, masteredRows, sourceTable.headers.length);
      await this.saveState();
      this.refreshReviewView();

      if (reason === "manual") {
        new Notice(`同步完成：${activeIds.size} 个未熟练，${masteredIds.size} 个已背诵。`);
      }
    } catch (error) {
      console.error("Word Table Sync error", error);
      new Notice("单词表同步失败，请打开开发者工具查看错误。");
    } finally {
      this.syncing = false;
    }
  }

  replaceTableRows(content, table, rows) {
    const lines = table.lines.slice();
    lines.splice(
      table.separatorIndex + 1,
      table.endIndex - (table.separatorIndex + 1),
      ...rows
    );
    return lines.join("\n");
  }

  syncStateFromTables(activeRows, masteredRows, columnCount) {
    const today = todayString();
    const intervals = parseIntervals(this.settings.reviewIntervals);
    const currentIds = new Set();

    const inspect = (row, inArchive) => {
      const cells = splitMarkdownRow(row);
      if (cells.length !== columnCount) return;

      const word = cells[0]?.trim();
      const code = cells[cells.length - 1]?.trim();
      if (!word || !isBinaryCode(code)) return;

      const id = getIdentity(cells);
      currentIds.add(id);

      const stage = getCompletedStage(code);
      const mastered = inArchive || isMastered(code);
      const old = this.state.words[id] || null;

      // First time this entry is seen.
      if (!old) {
        let nextReviewDate = null;
        if (!mastered) {
          if (stage <= 0) {
            nextReviewDate = today;
          } else if (stage < 6) {
            nextReviewDate = addDays(today, getGapAfterStage(stage, intervals));
          }
        }

        this.state.words[id] = {
          word,
          code,
          stage,
          startDate: today,
          lastReviewDate: null,
          nextReviewDate,
          mastered,
          updatedAt: new Date().toISOString()
        };
        return;
      }

      const oldStage = Number.isFinite(Number(old.stage)) ? Number(old.stage) : getCompletedStage(old.code);
      const oldMastered = !!old.mastered;
      let nextReviewDate = old.nextReviewDate || null;
      let lastReviewDate = old.lastReviewDate || null;

      if (mastered) {
        // Mastered rows do not need an active due date.
        nextReviewDate = null;
      } else if (oldMastered && !mastered) {
        // Reactivation: changing v back to 0 (or lowering the code) immediately
        // makes the word reviewable again, but preserves its historical start date.
        nextReviewDate = today;
      } else if (stage < oldStage) {
        // Manual reset to an earlier code is treated as a fresh review point.
        nextReviewDate = today;
      } else if (stage > oldStage) {
        // A review advances the plan from the ORIGINAL TARGET DATE, not from
        // the actual completion date. This prevents grace-day drift.
        let anchor = nextReviewDate || today;

        for (let completedStage = oldStage + 1; completedStage <= stage; completedStage++) {
          if (completedStage >= 6) {
            anchor = null;
            break;
          }

          const gap = getGapAfterStage(completedStage, intervals);
          anchor = addDays(anchor, gap);
        }

        nextReviewDate = anchor;
        lastReviewDate = today;
      }

      this.state.words[id] = {
        ...old,
        word,
        code,
        stage,
        lastReviewDate,
        nextReviewDate,
        mastered,
        updatedAt: new Date().toISOString()
      };
    };

    for (const row of activeRows) inspect(row, false);
    for (const row of masteredRows) inspect(row, true);

    // Once a word is no longer present in either table, its scheduling state
    // is no longer needed. A move between active/archive is still retained
    // because the word remains in currentIds.
    for (const id of Object.keys(this.state.words)) {
      if (!currentIds.has(id)) delete this.state.words[id];
    }
  }

  getCurrentTableRow() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return null;

    const lineNo = view.editor.getCursor().line;
    const lines = view.editor.getValue().split("\n");
    const row = lines[lineNo];
    if (!row || !row.trim().startsWith("|")) return null;

    const cells = splitMarkdownRow(row);
    if (cells.length < 2) return null;

    const code = cells[cells.length - 1]?.trim();
    if (!isBinaryCode(code)) return null;

    return { view, lineNo, row, cells, file: view.file };
  }

  getDueEntries() {
    const today = todayString();
    return Object.entries(this.state.words)
      .filter(([, item]) => {
        if (item.mastered || !item.nextReviewDate) return false;
        const targetStage = Math.min((Number(item.stage) || 0) + 1, 6);
        const status = classifyDueDate(item.nextReviewDate, targetStage, this.settings.reviewGraceDays, today);
        return status === "today" || status === "overdue";
      })
      .map(([id, item]) => ({ id, ...item }));
  }

  getDueGroups() {
    const today = todayString();
    const entries = Object.entries(this.state.words)
      .filter(([, item]) => !item.mastered && item.nextReviewDate)
      .map(([id, item]) => ({ id, ...item }));

    return {
      overdue: entries.filter(item => classifyDueDate(
        item.nextReviewDate,
        Math.min((Number(item.stage) || 0) + 1, 6),
        this.settings.reviewGraceDays,
        today
      ) === "overdue"),
      today: entries.filter(item => classifyDueDate(
        item.nextReviewDate,
        Math.min((Number(item.stage) || 0) + 1, 6),
        this.settings.reviewGraceDays,
        today
      ) === "today")
    };
  }

  getReviewWindowForItem(item) {
    return getReviewWindow(
      item.nextReviewDate,
      Math.min((Number(item.stage) || 0) + 1, 6),
      this.settings.reviewGraceDays
    );
  }

  async completeDueReviews(selectedIds = null) {
    const due = this.getDueEntries();
    const idSet = selectedIds ? new Set(selectedIds) : new Set(due.map(item => item.id));
    const entries = due.filter(item => idSet.has(item.id));

    if (!entries.length) {
      new Notice("当前没有到期复习。");
      return;
    }

    const sourcePath = normalizePath(this.settings.sourcePath);
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) {
      new Notice(`找不到单词表：${sourcePath}`);
      return;
    }

    const content = await this.app.vault.read(sourceFile);
    const table = this.parseTable(content);
    if (!table) {
      new Notice("没有识别到单词表。");
      return;
    }

    const targetIds = new Set(entries.map(item => item.id));
    const newRows = table.rows.map(row => {
      const cells = splitMarkdownRow(row);
      if (cells.length !== table.headers.length) return row;

      const id = getIdentity(cells);
      if (!targetIds.has(id)) return row;

      const result = advanceReviewCode(cells[cells.length - 1]);
      if (!result) return row;

      cells[cells.length - 1] = result.code;
      return `| ${cells.map(escapeCell).join(" | ")} |`;
    });

    const changed = newRows.some((row, index) => row !== table.rows[index]);
    if (changed) {
      await this.writeTextFile(sourcePath, this.replaceTableRows(content, table, newRows));
    }

    // sync() recalculates the next planned target from the old target date.
    await this.sync("auto");
    new Notice(`已完成 ${entries.length} 个到期单词的复习。`);
  }

  async recordReview(info) {
    const result = advanceReviewCode(info.cells[info.cells.length - 1]);
    if (!result) {
      new Notice("当前单词的 6 个复习阶段已经完成。请把第 7 位 v 手动设为 1，系统会自动归档。");
      return;
    }

    const newCells = info.cells.slice();
    newCells[newCells.length - 1] = result.code;
    const newRow = `| ${newCells.map(escapeCell).join(" | ")} |`;

    info.view.editor.setLine(info.lineNo, newRow);
    new Notice(`已记录：${newCells[0]} → ${result.code}。`);

    // MarkdownView writes the editor buffer to disk asynchronously. Delay the
    // synchronization so the state calculation reads the new code, not the
    // previous saved version.
    this.scheduleSync(650);
  }

  showReviewInfo(info) {
    const state = this.state.words[getIdentity(info.cells)];
    if (!state) {
      new Notice("这个单词还没有复习日期记录。");
      return;
    }

    const window = state.mastered ? null : this.getReviewWindowForItem(state);
    const message = state.mastered
      ? `${state.word}\n已熟练归档。`
      : `${state.word}\n编码：${state.code}\n阶段：${Math.min(state.stage, 6)}/6\n目标：${state.nextReviewDate || "—"}${window && window.grace > 0 ? `\n允许窗口：${window.start} ~ ${window.end}` : ""}`;

    new Notice(message, 7000);
  }

  async writeTextFile(path, content, force = false) {
    path = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(path);

    if (file instanceof TFile) {
      const old = await this.app.vault.read(file);
      if (old !== content) {
        if (!force) this.ignorePaths.add(path);
        await this.app.vault.modify(file, content);
      }
    } else {
      await this.ensureParentFolders(path);
      await this.app.vault.create(path, content);
    }
  }

  async ensureParentFolders(path) {
    const parts = path.split("/");
    if (parts.length <= 1) return;

    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (_) {}
      }
    }
  }
}

class WordReviewView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.container = null;
    this.refreshTimer = null;
  }

  getViewType() {
    return VIEW_TYPE_WORD_REVIEW;
  }

  getDisplayText() {
    return "单词复习";
  }

  getIcon() {
    return "calendar-check";
  }

  async onOpen() {
    this.container = this.contentEl;
    this.container.addClass("word-review-view");
    this.refresh();
  }

  async onClose() {
    clearTimeout(this.refreshTimer);
  }

  refresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.render(), 30);
  }

  render() {
    if (!this.container) return;
    this.container.empty();

    const groups = this.plugin.getDueGroups();
    const total = groups.overdue.length + groups.today.length;

    const header = this.container.createDiv("word-review-header");
    const titleRow = header.createDiv("word-review-title-row");
    titleRow.createEl("h2", { text: "单词复习" });

    const refreshButton = titleRow.createEl("button", {
      text: "↻",
      cls: "word-review-icon-button"
    });
    refreshButton.setAttr("aria-label", "刷新");
    refreshButton.addEventListener("click", () => this.refresh());

    header.createDiv({
      text: this.formatDate(todayString()),
      cls: "word-review-date"
    });

    const stats = this.container.createDiv("word-review-stats");
    this.addStat(stats, "逾期", groups.overdue.length, groups.overdue.length ? "is-overdue" : "");
    this.addStat(stats, "今日", groups.today.length, groups.today.length ? "is-today" : "");
    this.addStat(stats, "合计", total, "is-total");

    const action = this.container.createDiv("word-review-action");
    const completeAll = action.createEl("button", {
      text: total ? `一键完成今日复习（${total}）` : "当前没有到期复习",
      cls: "mod-cta word-review-complete-all"
    });
    completeAll.disabled = total === 0;
    completeAll.addEventListener("click", async () => {
      completeAll.disabled = true;
      await this.plugin.completeDueReviews();
      this.refresh();
    });

    this.renderSection("逾期单词", groups.overdue, "overdue");
    this.renderSection("今日到期", groups.today, "today");

    const footer = this.container.createDiv("word-review-footer");
    footer.textContent = "今日到期包含允许提前/延后的复习窗口；计划下一次仍以原目标日期为锚点，不会因提前或延后而漂移。";
  }

  addStat(parent, label, value, cls) {
    const box = parent.createDiv(`word-review-stat ${cls}`.trim());
    box.createDiv({ text: label, cls: "word-review-stat-label" });
    box.createDiv({ text: String(value), cls: "word-review-stat-value" });
  }

  renderSection(title, entries, kind) {
    const section = this.container.createDiv(`word-review-section word-review-section-${kind}`);
    section.createDiv({
      text: `${title}（${entries.length}）`,
      cls: "word-review-section-heading"
    });

    if (!entries.length) {
      section.createDiv({ text: "暂无", cls: "word-review-empty" });
      return;
    }

    const list = section.createDiv("word-review-list");

    for (const item of entries) {
      const row = list.createDiv("word-review-item");
      const main = row.createDiv("word-review-item-main");

      const word = main.createDiv({
        text: item.word,
        cls: "word-review-word"
      });
      word.setAttr("title", "点击打开原表中的单词");

      const meta = main.createDiv("word-review-meta");
      meta.createSpan({ text: `阶段 ${Math.min(item.stage || 0, 6)}/6` });
      meta.createSpan({ text: `目标：${item.nextReviewDate || "—"}` });

      const window = this.plugin.getReviewWindowForItem(item);
      if (window && window.grace > 0) {
        meta.createSpan({ text: `窗口：${window.start} ~ ${window.end}` });
      }
      meta.createSpan({ text: `编码：${item.code}` });

      const complete = row.createEl("button", {
        text: "完成",
        cls: "word-review-complete-button"
      });

      complete.addEventListener("click", async () => {
        complete.disabled = true;
        await this.plugin.completeDueReviews([item.id]);
        this.refresh();
      });

      word.addEventListener("click", () => this.openWord(item));
    }
  }

  async openWord(item) {
    const path = normalizePath(this.plugin.settings.sourcePath);
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const leaf = this.plugin.app.workspace.getMostRecentLeaf(false) || this.plugin.app.workspace.getLeaf(true);
    await leaf.openFile(file);

    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const lines = view.editor.getValue().split("\n");
    for (let line = 0; line < lines.length; line++) {
      if (!lines[line].trim().startsWith("|")) continue;
      const cells = splitMarkdownRow(lines[line]);
      if (cells.length < 2) continue;
      if (!isBinaryCode(cells[cells.length - 1])) continue;
      if (getIdentity(cells) !== item.id) continue;

      const pos = { line, ch: Math.min(2, lines[line].length) };
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
      break;
    }
  }

  formatDate(date) {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short"
      }).format(new Date(`${date}T00:00:00`));
    } catch (_) {
      return date;
    }
  }
}

class WordTableSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Word Table Sync" });

    const addPath = (name, description, key) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(description)
        .addText(text => text
          .setPlaceholder(DEFAULT_SETTINGS[key])
          .setValue(this.plugin.settings[key])
          .onChange(async value => {
            this.plugin.settings[key] = normalizePath(value.trim());
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.scheduleSync(50);
          }));
    };

    addPath("原始单词表", "自动识别其中的 Markdown 单词表。", "sourcePath");
    addPath("单词查看", "手机小组件读取的纯文本文件；下一行自动嵌入原始单词表。", "plainPath");
    addPath("已背诵单词表", "v=1 的完整表格行自动移动到这里；改为 v=0 可重新激活。", "masteredPath");
    addPath("状态文件", "保存复习日期、阶段和单词状态，不写入原单词表。", "statePath");

    new Setting(containerEl)
      .setName("纯文本分隔符")
      .setDesc("单词查看第一行的单词分隔符，例如：", ", ")
      .addText(text => text
        .setValue(this.plugin.settings.separator)
        .onChange(async value => {
          this.plugin.settings.separator = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.scheduleSync(50);
        }));

    new Setting(containerEl)
      .setName("复习间隔")
      .setDesc("完成第 1~5 个复习阶段后，下一阶段分别间隔多少天。默认 1,1,4,7,16，即 Day 1→2→3→7→14→30。")
      .addText(text => text
        .setValue(this.plugin.settings.reviewIntervals)
        .onChange(async value => {
          this.plugin.settings.reviewIntervals = value;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("复习时间容差")
      .setDesc("按 Day 1,2,3,7,14,30 设置允许提前/延后的天数。默认 0,0,0,1,1,2。")
      .addText(text => text
        .setValue(this.plugin.settings.reviewGraceDays)
        .onChange(async value => {
          this.plugin.settings.reviewGraceDays = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.refreshReviewView();
        }));

    new Setting(containerEl)
      .setName("自动同步")
      .setDesc("编辑原始单词表或已背诵单词表后自动同步。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async value => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("v=1 自动归档")
      .setDesc("只有第 7 位 v 存在且为 1 时才归档，不会误处理 1、11、111 等短编码。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoMoveMastered)
        .onChange(async value => {
          this.plugin.settings.autoMoveMastered = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.scheduleSync(50);
        }));

    new Setting(containerEl)
      .setName("v=0 重新激活")
      .setDesc("已归档单词的 v 改回 0 后，整行自动回到原始单词表，并立即进入复习队列。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoReactivate)
        .onChange(async value => {
          this.plugin.settings.autoReactivate = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.scheduleSync(50);
        }));

    new Setting(containerEl)
      .setName("复习侧边栏")
      .setDesc("显示今日到期与逾期单词，并可逐个或一键完成。")
      .addButton(button => button
        .setButtonText("打开侧边栏")
        .onClick(() => this.plugin.activateReviewView()));

    new Setting(containerEl)
      .setName("立即同步")
      .setDesc("手动执行一次完整同步。")
      .addButton(button => button
        .setButtonText("同步")
        .onClick(() => this.plugin.sync("manual")));
  }
}

module.exports = WordTableSyncPlugin;
