import { useState, useEffect, useRef, useMemo } from "react";

declare global {
  interface Window {
    initSqlJs: (config: { locateFile: (f: string) => string }) => Promise<any>;
    JSZip: any;
  }
}

const SQL_JS_VERSION = "1.10.3";
const SQL_JS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/sql.js/${SQL_JS_VERSION}`;
const JSZIP_CDN = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

type PresenceMode = "union" | "intersection" | "authoritativeA" | "authoritativeB";
type OverlapMode = "keepBoth" | "preferA" | "preferB" | "longer";
type PlaylistMode = "combine" | "preferA" | "preferB";
type NoteConflictMode = "newest" | "preferA" | "preferB";

interface MergeConfig {
  presence: PresenceMode;
  highlightOverlap: OverlapMode;
  playlistConflict: PlaylistMode;
  noteConflict: NoteConflictMode;
}

interface PresetDef {
  id: string;
  name: string;
  description: string;
  config: MergeConfig;
}

const PRESETS: PresetDef[] = [
  {
    id: "combine",
    name: "Combine everything",
    description: "Safe, reversible. Keeps every distinct highlight, note, tag, and bookmark from both files.",
    config: { presence: "union", highlightOverlap: "keepBoth", playlistConflict: "combine", noteConflict: "newest" },
  },
  {
    id: "preferA",
    name: "Prefer A on conflicts",
    description: "When the two files disagree on the same item, A wins. Items unique to either file are still kept.",
    config: { presence: "union", highlightOverlap: "preferA", playlistConflict: "preferA", noteConflict: "newest" },
  },
  {
    id: "preferB",
    name: "Prefer B on conflicts",
    description: "When the two files disagree on the same item, B wins. Items unique to either file are still kept.",
    config: { presence: "union", highlightOverlap: "preferB", playlistConflict: "preferB", noteConflict: "newest" },
  },
  {
    id: "authoritativeA",
    name: "A is the only source of truth",
    description: "Treat A as canonical. Items only in B are dropped. Use when B is stale.",
    config: { presence: "authoritativeA", highlightOverlap: "preferA", playlistConflict: "preferA", noteConflict: "newest" },
  },
  {
    id: "authoritativeB",
    name: "B is the only source of truth",
    description: "Treat B as canonical. Items only in A are deleted. Use when A is stale.",
    config: { presence: "authoritativeB", highlightOverlap: "preferB", playlistConflict: "preferB", noteConflict: "newest" },
  },
  {
    id: "longer",
    name: "Smart (longer wins)",
    description: "When highlights overlap, the longer one wins. Otherwise additive.",
    config: { presence: "union", highlightOverlap: "longer", playlistConflict: "combine", noteConflict: "newest" },
  },
  {
    id: "strict",
    name: "Strict (only what's in both)",
    description: "Only keep items present in both files. Aggressive — output may be small.",
    config: { presence: "intersection", highlightOverlap: "preferA", playlistConflict: "preferA", noteConflict: "newest" },
  },
];

interface JwFile {
  file: File;
  zip: any;
  manifest: any;
  dbBytes: Uint8Array;
  thumb: Uint8Array | null;
  counts: { notes: number; usermarks: number; tags: number; bookmarks: number };
  migrations: Set<string>;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadDeps() {
  await Promise.all([loadScript(`${SQL_JS_CDN}/sql-wasm.js`), loadScript(JSZIP_CDN)]);
  return await window.initSqlJs({ locateFile: (f: string) => `${SQL_JS_CDN}/${f}` });
}

function rows(db: any, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out: any[] = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function run(db: any, sql: string, params: any[] = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}

function insert(db: any, sql: string, params: any[] = []): number {
  run(db, sql, params);
  return db.exec("SELECT last_insert_rowid() AS id")[0].values[0][0];
}

function parseIso(ts: string | null | undefined): number {
  if (!ts) return 0;
  // JS Date.parse handles both 'Z' and '+0800'
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

function cascadeDeleteUserMark(db: any, umId: number) {
  const brCount = rows(db, "SELECT COUNT(*) AS c FROM BlockRange WHERE UserMarkId=?", [umId])[0].c;
  run(db, "DELETE FROM BlockRange WHERE UserMarkId=?", [umId]);
  const noteCount = rows(db, "SELECT COUNT(*) AS c FROM Note WHERE UserMarkId=?", [umId])[0].c;
  run(db, "UPDATE Note SET UserMarkId=NULL WHERE UserMarkId=?", [umId]);
  run(db, "DELETE FROM UserMark WHERE UserMarkId=?", [umId]);
  return { blockRanges: brCount, notesUnanchored: noteCount };
}

function cascadeDeleteNote(db: any, noteId: number) {
  const tmCount = rows(db, "SELECT COUNT(*) AS c FROM TagMap WHERE NoteId=?", [noteId])[0].c;
  run(db, "DELETE FROM TagMap WHERE NoteId=?", [noteId]);
  run(db, "DELETE FROM Note WHERE NoteId=?", [noteId]);
  return { tagMaps: tmCount };
}

function cascadeDeleteTag(db: any, tagId: number) {
  const tmCount = rows(db, "SELECT COUNT(*) AS c FROM TagMap WHERE TagId=?", [tagId])[0].c;
  run(db, "DELETE FROM TagMap WHERE TagId=?", [tagId]);
  run(db, "DELETE FROM Tag WHERE TagId=?", [tagId]);
  return { tagMaps: tmCount };
}

function totalTokenSpan(ranges: any[]): number {
  return ranges.reduce((sum, r) => sum + ((r.EndToken ?? 0) - (r.StartToken ?? 0) + 1), 0);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bump(d: Record<string, number>, k: string, n = 1) {
  d[k] = (d[k] ?? 0) + n;
}

interface MergeReport {
  config: MergeConfig;
  inserted: Record<string, number>;
  reused: Record<string, number>;
  skipped: Record<string, number>;
  deleted: Record<string, number>;
  conflicts: any[];
  warnings?: string[];
  mediaFilesInOutput?: number;
  unanchoredNotes?: number;
}

async function readJwlibrary(file: File): Promise<JwFile> {
  const buf = await file.arrayBuffer();
  const zip = await window.JSZip.loadAsync(buf);
  const manifestEntry = zip.file("manifest.json");
  const dbEntry = zip.file("userData.db");
  if (!manifestEntry || !dbEntry) {
    throw new Error(`${file.name} is not a valid .jwlibrary file (missing manifest.json or userData.db).`);
  }
  const manifest = JSON.parse(await manifestEntry.async("string"));
  const dbBytes = new Uint8Array(await dbEntry.async("arraybuffer"));
  const thumbEntry = zip.file("default_thumbnail.png");
  const thumb = thumbEntry ? new Uint8Array(await thumbEntry.async("arraybuffer")) : null;
  return { file, zip, manifest, dbBytes, thumb, counts: { notes: 0, usermarks: 0, tags: 0, bookmarks: 0 }, migrations: new Set() };
}

function loadCounts(SQL: any, jw: JwFile) {
  const db = new SQL.Database(jw.dbBytes);
  try {
    jw.counts.notes = rows(db, "SELECT COUNT(*) AS c FROM Note")[0].c;
    jw.counts.usermarks = rows(db, "SELECT COUNT(*) AS c FROM UserMark")[0].c;
    jw.counts.tags = rows(db, "SELECT COUNT(*) AS c FROM Tag")[0].c;
    jw.counts.bookmarks = rows(db, "SELECT COUNT(*) AS c FROM Bookmark")[0].c;
    jw.migrations = new Set(rows(db, "SELECT identifier FROM grdb_migrations").map((r: any) => r.identifier));
  } finally {
    db.close();
  }
}

async function mergeFiles(SQL: any, A: JwFile, B: JwFile, cfg: MergeConfig): Promise<{ blob: Blob; report: MergeReport; filename: string }> {
  const baseMig = A.migrations;
  const otherMig = B.migrations;
  if (baseMig.size !== otherMig.size || [...baseMig].some((m) => !otherMig.has(m))) {
    throw new Error(
      "Schema mismatch: the two backups were created by different versions of JW Library. Open both backups in JW Library on the same app version first to align them, then export again."
    );
  }
  if (A.manifest?.userDataBackup?.schemaVersion !== B.manifest?.userDataBackup?.schemaVersion) {
    throw new Error(
      `Schema version mismatch: A=${A.manifest?.userDataBackup?.schemaVersion}, B=${B.manifest?.userDataBackup?.schemaVersion}.`
    );
  }

  const base = new SQL.Database(new Uint8Array(A.dbBytes));
  const other = new SQL.Database(new Uint8Array(B.dbBytes));
  base.exec("PRAGMA foreign_keys = OFF");
  base.exec("BEGIN");

  const report: MergeReport = {
    config: cfg,
    inserted: {},
    reused: {},
    skipped: {},
    deleted: {},
    conflicts: [],
  };

  try {
    const { presence, highlightOverlap, playlistConflict, noteConflict } = cfg;

    // ---- 1. Location ----
    const locationIdMap: Record<number, number> = {};
    for (const row of rows(other, "SELECT * FROM Location")) {
      const existing = rows(
        base,
        "SELECT LocationId FROM Location WHERE " +
          "COALESCE(BookNumber,-1)=COALESCE(?,-1) AND " +
          "COALESCE(ChapterNumber,-1)=COALESCE(?,-1) AND " +
          "COALESCE(DocumentId,-1)=COALESCE(?,-1) AND " +
          "COALESCE(Track,-1)=COALESCE(?,-1) AND " +
          "IssueTagNumber=? AND " +
          "COALESCE(KeySymbol,'')=COALESCE(?,'') AND " +
          "COALESCE(MepsLanguage,-1)=COALESCE(?,-1) AND " +
          "Type=? AND COALESCE(Specialty,'')=? AND COALESCE(Edition,'')=?",
        [
          row.BookNumber, row.ChapterNumber, row.DocumentId, row.Track,
          row.IssueTagNumber, row.KeySymbol, row.MepsLanguage, row.Type,
          row.Specialty ?? "", row.Edition ?? "",
        ]
      )[0];
      if (existing) {
        locationIdMap[row.LocationId] = existing.LocationId;
        bump(report.reused, "Location");
      } else {
        const id = insert(
          base,
          "INSERT INTO Location (BookNumber,ChapterNumber,DocumentId,Track,IssueTagNumber,KeySymbol,MepsLanguage,Type,Title,Specialty,Edition) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [row.BookNumber, row.ChapterNumber, row.DocumentId, row.Track, row.IssueTagNumber, row.KeySymbol, row.MepsLanguage, row.Type, row.Title, row.Specialty, row.Edition]
        );
        locationIdMap[row.LocationId] = id;
        bump(report.inserted, "Location");
      }
    }

    // ---- 2. Tag ----
    const otherTagRows = rows(other, "SELECT * FROM Tag");
    const otherTagKeys = new Map<string, any>();
    otherTagRows.forEach((r) => otherTagKeys.set(`${r.Type} ${r.Name}`, r));
    const baseTagRows = rows(base, "SELECT * FROM Tag");
    const baseTagKeys = new Map<string, any>();
    baseTagRows.forEach((r) => baseTagKeys.set(`${r.Type} ${r.Name}`, r));
    const tagIdMap: Record<number, number> = {};
    for (const [key, row] of otherTagKeys) {
      const existing = baseTagKeys.get(key);
      if (existing) {
        tagIdMap[row.TagId] = existing.TagId;
        bump(report.reused, "Tag");
      } else {
        if (presence === "authoritativeA" || presence === "intersection") {
          bump(report.skipped, "Tag (presence)");
          continue;
        }
        const id = insert(base, "INSERT INTO Tag (Type, Name) VALUES (?, ?)", [row.Type, row.Name]);
        tagIdMap[row.TagId] = id;
        bump(report.inserted, "Tag");
      }
    }
    if (presence === "authoritativeB" || presence === "intersection") {
      for (const [key, row] of baseTagKeys) {
        if (!otherTagKeys.has(key)) {
          const stats = cascadeDeleteTag(base, row.TagId);
          bump(report.deleted, "Tag");
          bump(report.deleted, "TagMap (cascade)", stats.tagMaps);
        }
      }
    }

    // ---- 3. IndependentMedia & PlaylistItemAccuracy (additive) ----
    const indMediaIdMap: Record<number, number> = {};
    for (const row of rows(other, "SELECT * FROM IndependentMedia")) {
      const existing = rows(base, "SELECT IndependentMediaId FROM IndependentMedia WHERE FilePath=?", [row.FilePath])[0];
      if (existing) {
        indMediaIdMap[row.IndependentMediaId] = existing.IndependentMediaId;
        bump(report.reused, "IndependentMedia");
      } else {
        const id = insert(
          base,
          "INSERT INTO IndependentMedia (OriginalFilename,FilePath,MimeType,Hash) VALUES (?,?,?,?)",
          [row.OriginalFilename, row.FilePath, row.MimeType, row.Hash]
        );
        indMediaIdMap[row.IndependentMediaId] = id;
        bump(report.inserted, "IndependentMedia");
      }
    }
    const accuracyIdMap: Record<number, number> = {};
    for (const row of rows(other, "SELECT * FROM PlaylistItemAccuracy")) {
      const existing = rows(base, "SELECT PlaylistItemAccuracyId FROM PlaylistItemAccuracy WHERE Description=?", [row.Description])[0];
      if (existing) {
        accuracyIdMap[row.PlaylistItemAccuracyId] = existing.PlaylistItemAccuracyId;
      } else {
        const id = insert(base, "INSERT INTO PlaylistItemAccuracy (Description) VALUES (?)", [row.Description]);
        accuracyIdMap[row.PlaylistItemAccuracyId] = id;
      }
    }

    // ---- 4. UserMark ----
    const otherMarks = rows(other, "SELECT * FROM UserMark");
    const otherMarksByGuid = new Map<string, any>();
    otherMarks.forEach((r) => otherMarksByGuid.set(r.UserMarkGuid, r));
    const baseMarks = rows(base, "SELECT * FROM UserMark");
    const baseMarksByGuid = new Map<string, any>();
    baseMarks.forEach((r) => baseMarksByGuid.set(r.UserMarkGuid, r));
    const bRangesByUm: Record<number, any[]> = {};
    for (const br of rows(other, "SELECT * FROM BlockRange")) {
      (bRangesByUm[br.UserMarkId] ||= []).push(br);
    }
    if (presence === "authoritativeB" || presence === "intersection") {
      for (const [guid, row] of baseMarksByGuid) {
        if (!otherMarksByGuid.has(guid)) {
          const stats = cascadeDeleteUserMark(base, row.UserMarkId);
          bump(report.deleted, "UserMark (A-only)");
          bump(report.deleted, "BlockRange (cascade)", stats.blockRanges);
          bump(report.deleted, "Notes unanchored", stats.notesUnanchored);
        }
      }
    }
    const userMarkIdMap: Record<number, number> = {};
    const userMarkWasNew: Record<number, boolean> = {};
    for (const row of otherMarks) {
      const existing = rows(base, "SELECT UserMarkId FROM UserMark WHERE UserMarkGuid=?", [row.UserMarkGuid])[0];
      if (existing) {
        userMarkIdMap[row.UserMarkId] = existing.UserMarkId;
        userMarkWasNew[row.UserMarkId] = false;
        bump(report.reused, "UserMark");
        continue;
      }
      if (presence === "authoritativeA" || presence === "intersection") {
        bump(report.skipped, "UserMark (presence)");
        userMarkWasNew[row.UserMarkId] = false;
        continue;
      }
      const newLoc = locationIdMap[row.LocationId];
      const bRanges = bRangesByUm[row.UserMarkId] || [];
      const overlapping = new Set<number>();
      for (const br of bRanges) {
        const hits = rows(
          base,
          "SELECT br.UserMarkId AS uid FROM BlockRange br " +
            "JOIN UserMark um ON um.UserMarkId = br.UserMarkId " +
            "WHERE um.LocationId = ? AND br.BlockType = ? AND br.Identifier = ? " +
            "AND br.StartToken <= ? AND br.EndToken >= ?",
          [newLoc, br.BlockType, br.Identifier, br.EndToken, br.StartToken]
        );
        hits.forEach((h: any) => overlapping.add(h.uid));
      }
      if (overlapping.size === 0) {
        const id = insert(
          base,
          "INSERT INTO UserMark (ColorIndex,LocationId,StyleIndex,UserMarkGuid,Version) VALUES (?,?,?,?,?)",
          [row.ColorIndex, newLoc, row.StyleIndex, row.UserMarkGuid, row.Version]
        );
        userMarkIdMap[row.UserMarkId] = id;
        userMarkWasNew[row.UserMarkId] = true;
        bump(report.inserted, "UserMark");
        continue;
      }
      if (highlightOverlap === "keepBoth") {
        const id = insert(
          base,
          "INSERT INTO UserMark (ColorIndex,LocationId,StyleIndex,UserMarkGuid,Version) VALUES (?,?,?,?,?)",
          [row.ColorIndex, newLoc, row.StyleIndex, row.UserMarkGuid, row.Version]
        );
        userMarkIdMap[row.UserMarkId] = id;
        userMarkWasNew[row.UserMarkId] = true;
        bump(report.inserted, "UserMark (overlap, kept both)");
        report.conflicts.push({ table: "UserMark", guid: row.UserMarkGuid, overlap_with: [...overlapping].sort(), resolution: "kept both" });
      } else if (highlightOverlap === "preferA") {
        userMarkWasNew[row.UserMarkId] = false;
        bump(report.skipped, "UserMark (overlap, preferA)");
        report.conflicts.push({ table: "UserMark", guid: row.UserMarkGuid, overlap_with: [...overlapping].sort(), resolution: "B dropped" });
      } else if (highlightOverlap === "preferB") {
        for (const umId of overlapping) {
          const stats = cascadeDeleteUserMark(base, umId);
          bump(report.deleted, "UserMark (overlap, preferB)");
          bump(report.deleted, "BlockRange (cascade)", stats.blockRanges);
          bump(report.deleted, "Notes unanchored", stats.notesUnanchored);
        }
        const id = insert(
          base,
          "INSERT INTO UserMark (ColorIndex,LocationId,StyleIndex,UserMarkGuid,Version) VALUES (?,?,?,?,?)",
          [row.ColorIndex, newLoc, row.StyleIndex, row.UserMarkGuid, row.Version]
        );
        userMarkIdMap[row.UserMarkId] = id;
        userMarkWasNew[row.UserMarkId] = true;
        bump(report.inserted, "UserMark (overlap, preferB)");
        report.conflicts.push({ table: "UserMark", guid: row.UserMarkGuid, overlap_with: [...overlapping].sort(), resolution: "A dropped" });
      } else if (highlightOverlap === "longer") {
        const bTotal = totalTokenSpan(bRanges);
        let aTotal = 0;
        for (const umId of overlapping) {
          const rs = rows(base, "SELECT StartToken, EndToken FROM BlockRange WHERE UserMarkId=?", [umId]);
          aTotal += totalTokenSpan(rs);
        }
        let resolution: string;
        if (bTotal > aTotal) {
          for (const umId of overlapping) {
            const stats = cascadeDeleteUserMark(base, umId);
            bump(report.deleted, "UserMark (overlap, longer)");
            bump(report.deleted, "BlockRange (cascade)", stats.blockRanges);
            bump(report.deleted, "Notes unanchored", stats.notesUnanchored);
          }
          const id = insert(
            base,
            "INSERT INTO UserMark (ColorIndex,LocationId,StyleIndex,UserMarkGuid,Version) VALUES (?,?,?,?,?)",
            [row.ColorIndex, newLoc, row.StyleIndex, row.UserMarkGuid, row.Version]
          );
          userMarkIdMap[row.UserMarkId] = id;
          userMarkWasNew[row.UserMarkId] = true;
          bump(report.inserted, "UserMark (overlap, longer-B)");
          resolution = "B";
        } else {
          userMarkWasNew[row.UserMarkId] = false;
          bump(report.skipped, "UserMark (overlap, longer-A)");
          resolution = "A";
        }
        report.conflicts.push({ table: "UserMark", guid: row.UserMarkGuid, overlap_with: [...overlapping].sort(), b_span: bTotal, a_span: aTotal, resolution });
      }
    }

    // ---- 5. BlockRange ----
    for (const row of rows(other, "SELECT * FROM BlockRange")) {
      if (!userMarkWasNew[row.UserMarkId]) {
        bump(report.skipped, "BlockRange");
        continue;
      }
      const newUm = userMarkIdMap[row.UserMarkId];
      run(
        base,
        "INSERT INTO BlockRange (BlockType,Identifier,StartToken,EndToken,UserMarkId) VALUES (?,?,?,?,?)",
        [row.BlockType, row.Identifier, row.StartToken, row.EndToken, newUm]
      );
      bump(report.inserted, "BlockRange");
    }

    // ---- 6. Note ----
    const otherNotes = rows(other, "SELECT * FROM Note");
    const otherNoteGuids = new Set(otherNotes.map((r) => r.Guid));
    const baseNotes = rows(base, "SELECT * FROM Note");
    if (presence === "authoritativeB" || presence === "intersection") {
      for (const r of baseNotes) {
        if (!otherNoteGuids.has(r.Guid)) {
          const stats = cascadeDeleteNote(base, r.NoteId);
          bump(report.deleted, "Note (A-only)");
          bump(report.deleted, "TagMap (cascade)", stats.tagMaps);
        }
      }
    }
    const findReplacementUserMark = (locId: number | null, blockType: number | null, blockIdentifier: number | null): number | null => {
      if (locId == null || blockIdentifier == null) return null;
      const r = rows(
        base,
        "SELECT um.UserMarkId AS uid FROM UserMark um JOIN BlockRange br ON br.UserMarkId = um.UserMarkId " +
          "WHERE um.LocationId = ? AND br.BlockType = ? AND br.Identifier = ? " +
          "ORDER BY (br.EndToken - br.StartToken) DESC LIMIT 1",
        [locId, blockType, blockIdentifier]
      )[0];
      return r ? r.uid : null;
    };
    const noteIdMap: Record<number, number> = {};
    for (const row of otherNotes) {
      const existing = rows(base, "SELECT NoteId, LastModified, Title, Content, UserMarkId FROM Note WHERE Guid=?", [row.Guid])[0];
      const newLoc = row.LocationId != null ? locationIdMap[row.LocationId] : null;
      let newUm: number | null = row.UserMarkId != null ? userMarkIdMap[row.UserMarkId] ?? null : null;
      if (row.UserMarkId != null && newUm == null) {
        newUm = findReplacementUserMark(newLoc, row.BlockType, row.BlockIdentifier);
        if (newUm == null && existing && existing.UserMarkId != null) {
          newUm = existing.UserMarkId;
        }
      }
      if (existing) {
        noteIdMap[row.NoteId] = existing.NoteId;
        const otherNewer = parseIso(row.LastModified) > parseIso(existing.LastModified);
        const shouldOverwrite = (noteConflict === "newest" && otherNewer) || noteConflict === "preferB";
        if (shouldOverwrite) {
          run(
            base,
            "UPDATE Note SET Title=?, Content=?, LastModified=?, Created=?, BlockType=?, BlockIdentifier=?, UserMarkId=?, LocationId=? WHERE NoteId=?",
            [row.Title, row.Content, row.LastModified, row.Created, row.BlockType, row.BlockIdentifier, newUm, newLoc, existing.NoteId]
          );
          report.conflicts.push({
            table: "Note",
            guid: row.Guid,
            resolution: `overwritten (policy=${noteConflict})`,
            base_lm: existing.LastModified,
            other_lm: row.LastModified,
          });
          bump(report.reused, "Note (overwritten)");
        } else {
          bump(report.reused, "Note");
        }
      } else {
        if (presence === "authoritativeA" || presence === "intersection") {
          bump(report.skipped, "Note (presence)");
          continue;
        }
        const id = insert(
          base,
          "INSERT INTO Note (Guid,UserMarkId,LocationId,Title,Content,LastModified,Created,BlockType,BlockIdentifier) VALUES (?,?,?,?,?,?,?,?,?)",
          [row.Guid, newUm, newLoc, row.Title, row.Content, row.LastModified, row.Created, row.BlockType, row.BlockIdentifier]
        );
        noteIdMap[row.NoteId] = id;
        bump(report.inserted, "Note");
      }
    }

    // ---- 7. Bookmark ----
    const otherBookmarkKeys = new Set<string>();
    for (const r of rows(other, "SELECT * FROM Bookmark")) {
      const newLoc = locationIdMap[r.LocationId];
      const newPub = locationIdMap[r.PublicationLocationId];
      if (newLoc == null || newPub == null) continue;
      otherBookmarkKeys.add(`${newLoc} ${newPub} ${r.Title} ${r.BlockType} ${r.BlockIdentifier}`);
    }
    if (presence === "authoritativeB" || presence === "intersection") {
      for (const r of rows(base, "SELECT * FROM Bookmark")) {
        const k = `${r.LocationId} ${r.PublicationLocationId} ${r.Title} ${r.BlockType} ${r.BlockIdentifier}`;
        if (!otherBookmarkKeys.has(k)) {
          run(base, "DELETE FROM Bookmark WHERE BookmarkId=?", [r.BookmarkId]);
          bump(report.deleted, "Bookmark (A-only)");
        }
      }
    }
    for (const row of rows(other, "SELECT * FROM Bookmark")) {
      const newLoc = locationIdMap[row.LocationId];
      const newPub = locationIdMap[row.PublicationLocationId];
      const dup = rows(
        base,
        "SELECT BookmarkId FROM Bookmark WHERE LocationId=? AND PublicationLocationId=? AND Title=? AND COALESCE(BlockIdentifier,-1)=COALESCE(?,-1)",
        [newLoc, newPub, row.Title, row.BlockIdentifier]
      )[0];
      if (dup) {
        bump(report.skipped, "Bookmark (duplicate)");
        continue;
      }
      if (presence === "authoritativeA" || presence === "intersection") {
        bump(report.skipped, "Bookmark (presence)");
        continue;
      }
      let slot = row.Slot;
      const taken = new Set<number>(rows(base, "SELECT Slot FROM Bookmark WHERE PublicationLocationId=?", [newPub]).map((r: any) => r.Slot));
      if (taken.has(slot)) {
        let found = false;
        for (let c = 0; c < 10; c++) {
          if (!taken.has(c)) {
            slot = c;
            found = true;
            break;
          }
        }
        if (!found) {
          bump(report.skipped, "Bookmark (no free slot)");
          continue;
        }
      }
      run(
        base,
        "INSERT INTO Bookmark (LocationId,PublicationLocationId,Slot,Title,Snippet,BlockType,BlockIdentifier) VALUES (?,?,?,?,?,?,?)",
        [newLoc, newPub, slot, row.Title, row.Snippet, row.BlockType, row.BlockIdentifier]
      );
      bump(report.inserted, "Bookmark");
    }

    // ---- 8. InputField ----
    for (const row of rows(other, "SELECT * FROM InputField")) {
      const newLoc = locationIdMap[row.LocationId];
      if (rows(base, "SELECT 1 AS x FROM InputField WHERE LocationId=? AND TextTag=?", [newLoc, row.TextTag])[0]) {
        bump(report.skipped, "InputField");
        continue;
      }
      if (presence === "authoritativeA" || presence === "intersection") {
        bump(report.skipped, "InputField (presence)");
        continue;
      }
      run(base, "INSERT INTO InputField (LocationId,TextTag,Value) VALUES (?,?,?)", [newLoc, row.TextTag, row.Value]);
      bump(report.inserted, "InputField");
    }

    // ---- 9. Playlist family ----
    const baseItems = rows(base, "SELECT * FROM PlaylistItem");
    const baseItemsByKey = new Map<string, any>();
    baseItems.forEach((r) => baseItemsByKey.set(`${r.Label} ${r.ThumbnailFilePath}`, r));
    const otherItems = rows(other, "SELECT * FROM PlaylistItem");
    const aReferencedPi = new Set<number>(
      rows(base, "SELECT DISTINCT PlaylistItemId FROM TagMap WHERE PlaylistItemId IS NOT NULL").map((r: any) => r.PlaylistItemId)
    );
    const sharedPlaylistKeys = new Set<string>();
    for (const [k, row] of otherTagKeys) {
      if (row.Type === 2 && baseTagKeys.has(k)) sharedPlaylistKeys.add(k);
    }
    if (playlistConflict === "preferB") {
      for (const k of sharedPlaylistKeys) {
        const baseTid = baseTagKeys.get(k).TagId;
        const n = rows(base, "SELECT COUNT(*) AS c FROM TagMap WHERE TagId=?", [baseTid])[0].c;
        run(base, "DELETE FROM TagMap WHERE TagId=?", [baseTid]);
        bump(report.deleted, "TagMap (playlist preferB)", n);
      }
    }
    const playlistItemIdMap: Record<number, number> = {};
    const playlistItemWasNew: Record<number, boolean> = {};
    for (const row of otherItems) {
      const key = `${row.Label} ${row.ThumbnailFilePath}`;
      const existing = baseItemsByKey.get(key);
      if (existing) {
        playlistItemIdMap[row.PlaylistItemId] = existing.PlaylistItemId;
        playlistItemWasNew[row.PlaylistItemId] = false;
        bump(report.reused, "PlaylistItem");
      } else {
        const id = insert(
          base,
          "INSERT INTO PlaylistItem (Label,StartTrimOffsetTicks,EndTrimOffsetTicks,Accuracy,EndAction,ThumbnailFilePath) VALUES (?,?,?,?,?,?)",
          [row.Label, row.StartTrimOffsetTicks, row.EndTrimOffsetTicks, accuracyIdMap[row.Accuracy], row.EndAction, row.ThumbnailFilePath]
        );
        playlistItemIdMap[row.PlaylistItemId] = id;
        playlistItemWasNew[row.PlaylistItemId] = true;
        bump(report.inserted, "PlaylistItem");
      }
    }
    for (const row of rows(other, "SELECT * FROM PlaylistItemIndependentMediaMap")) {
      if (!playlistItemWasNew[row.PlaylistItemId]) {
        bump(report.skipped, "PlaylistItemIndependentMediaMap (parent reused)");
        continue;
      }
      const newPi = playlistItemIdMap[row.PlaylistItemId];
      const newIm = indMediaIdMap[row.IndependentMediaId];
      if (newIm == null) {
        bump(report.skipped, "PlaylistItemIndependentMediaMap (media missing)");
        continue;
      }
      if (rows(base, "SELECT 1 AS x FROM PlaylistItemIndependentMediaMap WHERE PlaylistItemId=? AND IndependentMediaId=?", [newPi, newIm])[0]) {
        bump(report.skipped, "PlaylistItemIndependentMediaMap (dup)");
        continue;
      }
      run(
        base,
        "INSERT INTO PlaylistItemIndependentMediaMap (PlaylistItemId,IndependentMediaId,DurationTicks) VALUES (?,?,?)",
        [newPi, newIm, row.DurationTicks]
      );
      bump(report.inserted, "PlaylistItemIndependentMediaMap");
    }
    for (const row of rows(other, "SELECT * FROM PlaylistItemLocationMap")) {
      if (!playlistItemWasNew[row.PlaylistItemId]) {
        bump(report.skipped, "PlaylistItemLocationMap (parent reused)");
        continue;
      }
      const newPi = playlistItemIdMap[row.PlaylistItemId];
      const newLoc = locationIdMap[row.LocationId];
      if (rows(base, "SELECT 1 AS x FROM PlaylistItemLocationMap WHERE PlaylistItemId=? AND LocationId=?", [newPi, newLoc])[0]) {
        bump(report.skipped, "PlaylistItemLocationMap (dup)");
        continue;
      }
      run(
        base,
        "INSERT INTO PlaylistItemLocationMap (PlaylistItemId,LocationId,MajorMultimediaType,BaseDurationTicks) VALUES (?,?,?,?)",
        [newPi, newLoc, row.MajorMultimediaType, row.BaseDurationTicks]
      );
      bump(report.inserted, "PlaylistItemLocationMap");
    }
    const markerIdMap: Record<number, number> = {};
    for (const row of rows(other, "SELECT * FROM PlaylistItemMarker")) {
      if (!playlistItemWasNew[row.PlaylistItemId]) {
        bump(report.skipped, "PlaylistItemMarker (parent reused)");
        continue;
      }
      const newPi = playlistItemIdMap[row.PlaylistItemId];
      const existing = rows(base, "SELECT PlaylistItemMarkerId FROM PlaylistItemMarker WHERE PlaylistItemId=? AND StartTimeTicks=?", [newPi, row.StartTimeTicks])[0];
      if (existing) {
        markerIdMap[row.PlaylistItemMarkerId] = existing.PlaylistItemMarkerId;
        bump(report.reused, "PlaylistItemMarker");
      } else {
        const id = insert(
          base,
          "INSERT INTO PlaylistItemMarker (PlaylistItemId,Label,StartTimeTicks,DurationTicks,EndTransitionDurationTicks) VALUES (?,?,?,?,?)",
          [newPi, row.Label, row.StartTimeTicks, row.DurationTicks, row.EndTransitionDurationTicks]
        );
        markerIdMap[row.PlaylistItemMarkerId] = id;
        bump(report.inserted, "PlaylistItemMarker");
      }
    }
    for (const row of rows(other, "SELECT * FROM PlaylistItemMarkerBibleVerseMap")) {
      const newM = markerIdMap[row.PlaylistItemMarkerId];
      if (newM == null) {
        bump(report.skipped, "MarkerBibleVerseMap (parent reused)");
        continue;
      }
      if (rows(base, "SELECT 1 AS x FROM PlaylistItemMarkerBibleVerseMap WHERE PlaylistItemMarkerId=? AND VerseId=?", [newM, row.VerseId])[0]) {
        bump(report.skipped, "MarkerBibleVerseMap (dup)");
        continue;
      }
      run(base, "INSERT INTO PlaylistItemMarkerBibleVerseMap (PlaylistItemMarkerId,VerseId) VALUES (?,?)", [newM, row.VerseId]);
      bump(report.inserted, "MarkerBibleVerseMap");
    }
    for (const row of rows(other, "SELECT * FROM PlaylistItemMarkerParagraphMap")) {
      const newM = markerIdMap[row.PlaylistItemMarkerId];
      if (newM == null) {
        bump(report.skipped, "MarkerParagraphMap (parent reused)");
        continue;
      }
      if (
        rows(
          base,
          "SELECT 1 AS x FROM PlaylistItemMarkerParagraphMap WHERE PlaylistItemMarkerId=? AND MepsDocumentId=? AND ParagraphIndex=? AND MarkerIndexWithinParagraph=?",
          [newM, row.MepsDocumentId, row.ParagraphIndex, row.MarkerIndexWithinParagraph]
        )[0]
      ) {
        bump(report.skipped, "MarkerParagraphMap (dup)");
        continue;
      }
      run(
        base,
        "INSERT INTO PlaylistItemMarkerParagraphMap (PlaylistItemMarkerId,MepsDocumentId,ParagraphIndex,MarkerIndexWithinParagraph) VALUES (?,?,?,?)",
        [newM, row.MepsDocumentId, row.ParagraphIndex, row.MarkerIndexWithinParagraph]
      );
      bump(report.inserted, "MarkerParagraphMap");
    }

    // ---- 10. TagMap with playlist policy ----
    const otherTagIdToKey = new Map<number, string>();
    for (const r of rows(other, "SELECT * FROM Tag")) otherTagIdToKey.set(r.TagId, `${r.Type} ${r.Name}`);
    for (const row of rows(other, "SELECT * FROM TagMap")) {
      if (!(row.TagId in tagIdMap)) {
        bump(report.skipped, "TagMap (tag dropped)");
        continue;
      }
      const isPlaylist = row.PlaylistItemId != null;
      if (isPlaylist && playlistConflict === "preferA") {
        const tagKey = otherTagIdToKey.get(row.TagId);
        if (tagKey && sharedPlaylistKeys.has(tagKey)) {
          bump(report.skipped, "TagMap (playlist preferA)");
          continue;
        }
      }
      const newTag = tagIdMap[row.TagId];
      const newNote = row.NoteId != null ? noteIdMap[row.NoteId] ?? null : null;
      const newLoc = row.LocationId != null ? locationIdMap[row.LocationId] : null;
      const newPi = row.PlaylistItemId != null ? playlistItemIdMap[row.PlaylistItemId] ?? null : null;
      if (row.NoteId != null && newNote == null) {
        bump(report.skipped, "TagMap (note dropped)");
        continue;
      }
      let already: any = null;
      if (newNote != null) {
        already = rows(base, "SELECT 1 AS x FROM TagMap WHERE TagId=? AND NoteId=?", [newTag, newNote])[0];
      } else if (newLoc != null) {
        already = rows(base, "SELECT 1 AS x FROM TagMap WHERE TagId=? AND LocationId=?", [newTag, newLoc])[0];
      } else if (newPi != null) {
        already = rows(base, "SELECT 1 AS x FROM TagMap WHERE TagId=? AND PlaylistItemId=?", [newTag, newPi])[0];
      }
      if (already) {
        bump(report.skipped, "TagMap");
        continue;
      }
      const maxPos = rows(base, "SELECT COALESCE(MAX(Position), -1) AS m FROM TagMap WHERE TagId=?", [newTag])[0].m;
      run(
        base,
        "INSERT INTO TagMap (PlaylistItemId,LocationId,NoteId,TagId,Position) VALUES (?,?,?,?,?)",
        [newPi, newLoc, newNote, newTag, maxPos + 1]
      );
      bump(report.inserted, "TagMap");
    }

    // ---- 10b. Cleanup orphaned PlaylistItems ----
    if (playlistConflict === "preferA" || playlistConflict === "preferB") {
      const newBPiIds = new Set<number>();
      for (const bid in playlistItemWasNew) {
        if (playlistItemWasNew[bid as any]) newBPiIds.add(playlistItemIdMap[bid as any]);
      }
      const orphans = rows(
        base,
        "SELECT pi.PlaylistItemId AS pid FROM PlaylistItem pi WHERE NOT EXISTS (SELECT 1 FROM TagMap WHERE PlaylistItemId = pi.PlaylistItemId)"
      ).map((r: any) => r.pid);
      for (const pid of orphans) {
        if (!newBPiIds.has(pid) && !aReferencedPi.has(pid)) continue;
        run(
          base,
          "DELETE FROM PlaylistItemMarkerBibleVerseMap WHERE PlaylistItemMarkerId IN (SELECT PlaylistItemMarkerId FROM PlaylistItemMarker WHERE PlaylistItemId=?)",
          [pid]
        );
        run(
          base,
          "DELETE FROM PlaylistItemMarkerParagraphMap WHERE PlaylistItemMarkerId IN (SELECT PlaylistItemMarkerId FROM PlaylistItemMarker WHERE PlaylistItemId=?)",
          [pid]
        );
        run(base, "DELETE FROM PlaylistItemMarker WHERE PlaylistItemId=?", [pid]);
        run(base, "DELETE FROM PlaylistItemIndependentMediaMap WHERE PlaylistItemId=?", [pid]);
        run(base, "DELETE FROM PlaylistItemLocationMap WHERE PlaylistItemId=?", [pid]);
        run(base, "DELETE FROM PlaylistItem WHERE PlaylistItemId=?", [pid]);
        bump(report.deleted, "PlaylistItem (orphaned)");
      }
    }

    // ---- 11. Cleanup orphaned IndependentMedia ----
    const unused = rows(
      base,
      "SELECT IndependentMediaId, FilePath FROM IndependentMedia im " +
        "WHERE NOT EXISTS (SELECT 1 FROM PlaylistItem WHERE ThumbnailFilePath = im.FilePath) " +
        "AND NOT EXISTS (SELECT 1 FROM PlaylistItemIndependentMediaMap WHERE IndependentMediaId = im.IndependentMediaId)"
    );
    for (const r of unused) {
      run(base, "DELETE FROM IndependentMedia WHERE IndependentMediaId=?", [r.IndependentMediaId]);
      bump(report.deleted, "IndependentMedia (unused)");
    }

    base.exec("COMMIT");
  } catch (e) {
    base.exec("ROLLBACK");
    base.close();
    other.close();
    throw e;
  }

  // VACUUM must happen outside transaction
  try {
    base.exec("VACUUM");
  } catch {
    /* non-fatal */
  }

  // Count unanchored notes
  report.unanchoredNotes = rows(base, "SELECT COUNT(*) AS c FROM Note WHERE UserMarkId IS NULL")[0].c;

  // Collect surviving media file paths
  const referencedFiles = new Set<string>(rows(base, "SELECT FilePath FROM IndependentMedia").map((r: any) => r.FilePath));

  // Export merged DB
  const dbBytes: Uint8Array = base.export();
  base.close();
  other.close();

  // Build manifest
  const newHash = await sha256Hex(dbBytes);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const manifest = JSON.parse(JSON.stringify(A.manifest));
  manifest.userDataBackup.hash = newHash;
  manifest.userDataBackup.lastModifiedDate = now;
  if (manifest.userDataBackup.deviceName) {
    manifest.userDataBackup.deviceName = "merged";
  }
  manifest.creationDate = now;
  const filename = `UserdataBackup_${now.slice(0, 10)}_merged.jwlibrary`;
  manifest.name = filename;

  // Build output ZIP
  const outZip = new window.JSZip();
  outZip.file("manifest.json", JSON.stringify(manifest));
  outZip.file("userData.db", dbBytes);
  if (A.thumb) outZip.file("default_thumbnail.png", A.thumb);

  const warnings: string[] = [];
  let mediaAdded = 0;
  for (const fname of referencedFiles) {
    const fileEntry = A.zip.file(fname) || B.zip.file(fname);
    if (fileEntry) {
      const bytes = new Uint8Array(await fileEntry.async("arraybuffer"));
      outZip.file(fname, bytes);
      mediaAdded++;
    } else {
      warnings.push(`Media file referenced in DB but not found in either source ZIP: ${fname}`);
    }
  }
  report.mediaFilesInOutput = mediaAdded;
  if (warnings.length) report.warnings = warnings;

  const blob = await outZip.generateAsync({ type: "blob", compression: "DEFLATE" });
  return { blob, report, filename };
}

function FileDropZone({
  label,
  jwFile,
  onFile,
  onClear,
  disabled,
}: {
  label: string;
  jwFile: JwFile | null;
  onFile: (file: File) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={`rounded-2xl border-2 border-dashed p-6 transition-all ${
        dragOver ? "border-orange bg-orange/10" : jwFile ? "border-dark/30 bg-white" : "border-dark/20 bg-white/60 hover:border-dark/40"
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium tracking-widest uppercase text-dark/60">{label}</span>
        {jwFile && (
          <button
            onClick={onClear}
            disabled={disabled}
            className="text-xs text-dark/50 hover:text-dark underline-offset-2 hover:underline disabled:opacity-40"
          >
            clear
          </button>
        )}
      </div>
      {jwFile ? (
        <div className="space-y-2">
          <div className="font-medium text-dark break-all">{jwFile.file.name}</div>
          <div className="text-xs text-dark/60 grid grid-cols-2 gap-x-4 gap-y-1">
            <span>Size: {(jwFile.file.size / 1024).toFixed(1)} KB</span>
            <span>Schema: v{jwFile.manifest?.userDataBackup?.schemaVersion}</span>
            <span>Device: {jwFile.manifest?.userDataBackup?.deviceName ?? "—"}</span>
            <span>Modified: {(jwFile.manifest?.userDataBackup?.lastModifiedDate ?? "").slice(0, 10) || "—"}</span>
          </div>
          <div className="pt-2 border-t border-dark/10 text-xs text-dark/70 grid grid-cols-4 gap-2">
            <div><span className="block text-dark font-medium text-base">{jwFile.counts.notes}</span>Notes</div>
            <div><span className="block text-dark font-medium text-base">{jwFile.counts.usermarks}</span>Highlights</div>
            <div><span className="block text-dark font-medium text-base">{jwFile.counts.tags}</span>Tags</div>
            <div><span className="block text-dark font-medium text-base">{jwFile.counts.bookmarks}</span>Bookmarks</div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="w-full text-center py-8 text-dark/60 hover:text-dark disabled:opacity-40"
        >
          <div className="text-base mb-1">Drop a .jwlibrary file here</div>
          <div className="text-xs">or click to choose</div>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".jwlibrary,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function PolicySection({
  cfg,
  setCfg,
  showAdvanced,
  setShowAdvanced,
  presetId,
  setPresetId,
}: {
  cfg: MergeConfig;
  setCfg: (c: MergeConfig) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  presetId: string;
  setPresetId: (id: string) => void;
}) {
  return (
    <div className="rounded-2xl bg-white border border-dark/10 p-6">
      <div className="text-xs font-medium tracking-widest uppercase text-dark/60 mb-3">Conflict policy</div>
      <select
        value={presetId}
        onChange={(e) => {
          const id = e.target.value;
          setPresetId(id);
          if (id !== "custom") {
            const p = PRESETS.find((p) => p.id === id);
            if (p) setCfg(p.config);
          }
        }}
        className="w-full px-4 py-3 rounded-xl border border-dark/15 bg-white text-dark focus:outline-none focus:border-orange"
      >
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      <p className="text-xs text-dark/60 mt-2">
        {presetId === "custom"
          ? "Set each policy individually below."
          : PRESETS.find((p) => p.id === presetId)?.description}
      </p>

      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-xs text-dark/50 hover:text-dark mt-4 underline-offset-2 hover:underline"
      >
        {showAdvanced ? "Hide" : "Show"} advanced
      </button>

      {showAdvanced && (
        <div className="mt-4 space-y-4 pt-4 border-t border-dark/10">
          <PolicyDropdown
            label="Presence (items in only one file)"
            tooltip="A 2-way merge can't tell 'added on X' from 'deleted on Y'. Pick how to resolve."
            value={cfg.presence}
            options={[
              { v: "union", l: "union — keep all (additive)" },
              { v: "intersection", l: "intersection — only items in both files" },
              { v: "authoritativeA", l: "authoritativeA — A is canonical" },
              { v: "authoritativeB", l: "authoritativeB — B is canonical" },
            ]}
            onChange={(v) => {
              setCfg({ ...cfg, presence: v as PresenceMode });
              setPresetId("custom");
            }}
          />
          <PolicyDropdown
            label="Highlight overlap (different GUIDs covering the same passage)"
            tooltip="When two different highlights cover overlapping text, choose how to resolve."
            value={cfg.highlightOverlap}
            options={[
              { v: "keepBoth", l: "keepBoth — render stacked" },
              { v: "preferA", l: "preferA — keep A's highlight" },
              { v: "preferB", l: "preferB — keep B's highlight (cascade)" },
              { v: "longer", l: "longer — whichever covers more tokens wins" },
            ]}
            onChange={(v) => {
              setCfg({ ...cfg, highlightOverlap: v as OverlapMode });
              setPresetId("custom");
            }}
          />
          <PolicyDropdown
            label="Same-name playlists"
            tooltip="When the same playlist name exists in both files, how to combine their items."
            value={cfg.playlistConflict}
            options={[
              { v: "combine", l: "combine — merge items (deduped)" },
              { v: "preferA", l: "preferA — A's items only" },
              { v: "preferB", l: "preferB — B's items only" },
            ]}
            onChange={(v) => {
              setCfg({ ...cfg, playlistConflict: v as PlaylistMode });
              setPresetId("custom");
            }}
          />
          <PolicyDropdown
            label="Note content conflicts"
            tooltip="When the same note Guid appears in both files with different content."
            value={cfg.noteConflict}
            options={[
              { v: "newest", l: "newest — most recent LastModified wins" },
              { v: "preferA", l: "preferA — A's text wins" },
              { v: "preferB", l: "preferB — B's text wins" },
            ]}
            onChange={(v) => {
              setCfg({ ...cfg, noteConflict: v as NoteConflictMode });
              setPresetId("custom");
            }}
          />
        </div>
      )}
    </div>
  );
}

function PolicyDropdown({
  label, tooltip, value, options, onChange,
}: {
  label: string; tooltip: string; value: string;
  options: { v: string; l: string }[]; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-dark mb-1">{label}</label>
      <p className="text-[11px] text-dark/50 mb-2">{tooltip}</p>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-dark/15 bg-white text-dark text-sm focus:outline-none focus:border-orange"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>{o.l}</option>
        ))}
      </select>
    </div>
  );
}

function ReportView({ report, downloadUrl, downloadName, onReset }: { report: MergeReport; downloadUrl: string; downloadName: string; onReset: () => void }) {
  const sections: { title: string; data: Record<string, number> }[] = [
    { title: "Inserted", data: report.inserted },
    { title: "Reused", data: report.reused },
    { title: "Skipped", data: report.skipped },
    { title: "Deleted", data: report.deleted },
  ];
  return (
    <div className="rounded-2xl bg-white border border-dark/10 p-6 space-y-5">
      <div>
        <div className="text-xs font-medium tracking-widest uppercase text-dark/60 mb-2">Merge complete</div>
        <a
          href={downloadUrl}
          download={downloadName}
          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-dark text-white font-medium hover:bg-orange hover:text-dark transition-colors"
        >
          ↓ Download {downloadName}
        </a>
        {report.unanchoredNotes != null && report.unanchoredNotes > 0 && (
          <p className="text-xs text-dark/60 mt-3">
            {report.unanchoredNotes} note{report.unanchoredNotes === 1 ? "" : "s"} ended up unanchored. The text is preserved
            but not attached to a highlight any more.
          </p>
        )}
        {report.mediaFilesInOutput != null && (
          <p className="text-xs text-dark/50 mt-1">{report.mediaFilesInOutput} media file{report.mediaFilesInOutput === 1 ? "" : "s"} bundled.</p>
        )}
      </div>

      {report.warnings && report.warnings.length > 0 && (
        <div className="rounded-xl bg-orange/15 border border-orange/40 px-4 py-3 text-xs text-dark">
          <div className="font-medium mb-1">Warnings</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {report.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        {sections.map((s) => (
          <div key={s.title} className="rounded-xl bg-gray border border-dark/5 p-4">
            <div className="text-xs font-medium tracking-widest uppercase text-dark/50 mb-2">{s.title}</div>
            {Object.keys(s.data).length === 0 ? (
              <div className="text-xs text-dark/40">—</div>
            ) : (
              <ul className="text-xs space-y-1">
                {Object.entries(s.data).map(([k, v]) => (
                  <li key={k} className="flex justify-between gap-3">
                    <span className="text-dark/70">{k}</span>
                    <span className="font-medium tabular-nums">{v}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {report.conflicts.length > 0 && (
        <details className="rounded-xl bg-gray border border-dark/5 p-4">
          <summary className="cursor-pointer text-xs font-medium tracking-widest uppercase text-dark/50">
            Conflicts resolved ({report.conflicts.length})
          </summary>
          <ul className="mt-3 text-xs space-y-2 max-h-64 overflow-y-auto">
            {report.conflicts.slice(0, 200).map((c, i) => (
              <li key={i} className="border-b border-dark/5 pb-2 last:border-0">
                <span className="font-medium">{c.table}</span>{" "}
                <span className="text-dark/50 break-all">{c.guid}</span>{" — "}
                <span>{c.resolution}</span>
                {c.base_lm && c.other_lm && (
                  <span className="block text-dark/50 mt-0.5">A: {c.base_lm} • B: {c.other_lm}</span>
                )}
              </li>
            ))}
            {report.conflicts.length > 200 && (
              <li className="text-dark/40">… and {report.conflicts.length - 200} more</li>
            )}
          </ul>
        </details>
      )}

      <button
        type="button"
        onClick={onReset}
        className="text-xs text-dark/50 hover:text-dark underline-offset-2 hover:underline"
      >
        Start over with new files
      </button>
    </div>
  );
}

export default function JwLibraryMerger() {
  const [SQL, setSQL] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fileA, setFileA] = useState<JwFile | null>(null);
  const [fileB, setFileB] = useState<JwFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [presetId, setPresetId] = useState("combine");
  const [cfg, setCfg] = useState<MergeConfig>(PRESETS[0].config);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [report, setReport] = useState<MergeReport | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState<string>("");

  useEffect(() => {
    loadDeps()
      .then(setSQL)
      .catch((e) => setLoadError(e.message || String(e)));
  }, []);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  const schemaCompatible = useMemo(() => {
    if (!fileA || !fileB) return null;
    const aV = fileA.manifest?.userDataBackup?.schemaVersion;
    const bV = fileB.manifest?.userDataBackup?.schemaVersion;
    if (aV !== bV) return false;
    if (fileA.migrations.size !== fileB.migrations.size) return false;
    for (const m of fileA.migrations) if (!fileB.migrations.has(m)) return false;
    return true;
  }, [fileA, fileB]);

  const handleFile = async (slot: "A" | "B", file: File) => {
    if (!SQL) return;
    setFileError(null);
    setReport(null);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }
    try {
      const jw = await readJwlibrary(file);
      loadCounts(SQL, jw);
      if (slot === "A") setFileA(jw);
      else setFileB(jw);
    } catch (e: any) {
      setFileError(`Failed to read ${file.name}: ${e.message || e}`);
    }
  };

  const handleMerge = async () => {
    if (!SQL || !fileA || !fileB) return;
    setMerging(true);
    setMergeError(null);
    setReport(null);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }
    try {
      // Yield to the browser so the spinner renders before the heavy merge.
      await new Promise((r) => setTimeout(r, 50));
      const { blob, report, filename } = await mergeFiles(SQL, fileA, fileB, cfg);
      setReport(report);
      setDownloadUrl(URL.createObjectURL(blob));
      setDownloadName(filename);
    } catch (e: any) {
      setMergeError(e.message || String(e));
    } finally {
      setMerging(false);
    }
  };

  const handleReset = () => {
    setFileA(null);
    setFileB(null);
    setReport(null);
    setMergeError(null);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
  };

  return (
    <div className="min-h-screen bg-gray font-sans text-dark">
      <div className="max-w-3xl mx-auto px-5 py-12 sm:py-20">
        <header className="mb-10">
          <div className="text-xs font-medium tracking-widest uppercase text-orange mb-3">JW Library tools</div>
          <h1 className="text-3xl sm:text-5xl font-medium tracking-tight mb-3">Backup merger</h1>
          <p className="text-base text-dark/70 max-w-xl">
            Merge two <code className="px-1 py-0.5 bg-white rounded text-sm">.jwlibrary</code> backups into one.
            Highlights, notes, tags, bookmarks and playlists from both devices, combined with the conflict policy you choose.
          </p>
          <p className="text-xs text-dark/50 mt-3">Files never leave your browser. Everything runs locally.</p>
        </header>

        {loadError && (
          <div className="rounded-2xl bg-orange/15 border border-orange/40 p-5 mb-6 text-sm">
            Couldn't load the merge engine: {loadError}. Check your internet connection and refresh.
          </div>
        )}

        {!loadError && !SQL && (
          <div className="text-sm text-dark/60 py-10 text-center">Loading merge engine…</div>
        )}

        {SQL && (
          <>
            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              <FileDropZone label="File A (base)" jwFile={fileA} onFile={(f) => handleFile("A", f)} onClear={() => setFileA(null)} disabled={merging} />
              <FileDropZone label="File B (other)" jwFile={fileB} onFile={(f) => handleFile("B", f)} onClear={() => setFileB(null)} disabled={merging} />
            </div>

            {fileError && (
              <div className="rounded-xl bg-orange/15 border border-orange/40 px-4 py-3 mb-4 text-xs text-dark">{fileError}</div>
            )}

            {fileA && fileB && schemaCompatible === false && (
              <div className="rounded-xl bg-orange/15 border border-orange/40 px-4 py-3 mb-4 text-sm text-dark">
                <strong>Schema mismatch.</strong> The two backups were created by different versions of JW Library
                (A: v{fileA.manifest?.userDataBackup?.schemaVersion}, B: v{fileB.manifest?.userDataBackup?.schemaVersion}).
                Open both backups in JW Library on the same app version first to align them, then export again.
              </div>
            )}

            <div className="mb-4">
              <PolicySection
                cfg={cfg} setCfg={setCfg}
                showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced}
                presetId={presetId} setPresetId={setPresetId}
              />
            </div>

            <button
              type="button"
              onClick={handleMerge}
              disabled={!fileA || !fileB || schemaCompatible === false || merging}
              className="w-full py-4 rounded-2xl bg-dark text-white font-medium text-base hover:bg-orange hover:text-dark transition-colors disabled:bg-dark/20 disabled:text-dark/40 disabled:cursor-not-allowed"
            >
              {merging ? "Merging…" : "Merge backups"}
            </button>

            {mergeError && (
              <div className="rounded-xl bg-orange/15 border border-orange/40 px-4 py-3 mt-4 text-sm text-dark whitespace-pre-wrap">
                {mergeError}
              </div>
            )}

            {report && downloadUrl && (
              <div className="mt-6">
                <ReportView report={report} downloadUrl={downloadUrl} downloadName={downloadName} onReset={handleReset} />
              </div>
            )}
          </>
        )}

        <footer className="mt-16 pt-6 border-t border-dark/10 text-xs text-dark/40">
          <a href="https://www.nudgetheweb.com/" className="hover:text-dark">Nudge the Web</a>
        </footer>
      </div>
    </div>
  );
}
