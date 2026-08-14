import {
    UIContainer,
    createCta,
    createSpacer,
    createTextSpan
} from 'browser-scraping-utils';

/**
 * WhatsApp Web group-member exporter.
 * Reads IndexedDB `model-storage` (readonly). No DOM member-modal scraping.
 */

const DB_NAME = 'model-storage';
const DEFAULT_STATUS = 'Open a group, then Export';
const EXPORT_PREFIX = 'whatsAppExport';

const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BIDI_AND_SPACE = /[\s\-\(\)\.\u00a0\u202f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const CHAT_STORE_CANDIDATES = ['chat', 'chats'];
const PARTICIPANT_STORE_CANDIDATES = ['participant', 'participants'];
const CONTACT_STORE_CANDIDATES = ['contact', 'contacts'];
const GROUP_META_STORE_CANDIDATES = [
    'group-metadata',
    'groupMetadata',
    'group_metadata',
    'group-meta'
];

interface MemberRow {
    phoneNumber: string;
    name: string;
    pushname: string;
    source: string;
    id: string;
    isAdmin?: boolean;
}

interface ParticipantRef {
    id: string;
    isAdmin?: boolean;
    name?: string;
}

interface ResolvedGroup {
    id: string;
    name: string;
    usedFallback: boolean;
    fallbackReason: string;
}

type IdRecord = Record<string, unknown>;

function stripBidi(text: string): string {
    return text.replace(BIDI_MARKS, '');
}

function normalizeText(text: string): string {
    return stripBidi(text).replace(/\s+/g, ' ').trim();
}

function isPhoneNumber(text: string): boolean {
    const stripped = text.replace(BIDI_AND_SPACE, '');
    return /^\+?\d{6,15}$/.test(stripped);
}

function asRecord(value: unknown): IdRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as IdRecord;
}

function asArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const rec = asRecord(value);
    if (!rec) return [];
    if (Array.isArray(rec._models)) return rec._models;
    if (Array.isArray(rec.models)) return rec.models;
    if (Array.isArray(rec.toArray)) return rec.toArray as unknown[];
    return [];
}

function serializeId(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
    }
    const rec = asRecord(value);
    if (!rec) return '';
    if (typeof rec._serialized === 'string') return rec._serialized;
    if (typeof rec.id === 'string') return rec.id;
    if (rec.user != null && rec.server != null) {
        return `${rec.user}@${rec.server}`;
    }
    if (typeof rec.wid === 'string') return rec.wid;
    if (rec.wid) return serializeId(rec.wid);
    return '';
}

function userPart(wid: string): string {
    const s = normalizeText(wid);
    const at = s.indexOf('@');
    return at >= 0 ? s.slice(0, at) : s;
}

function serverPart(wid: string): string {
    const s = normalizeText(wid);
    const at = s.indexOf('@');
    return at >= 0 ? s.slice(at + 1) : '';
}

function idsEqual(a: string, b: string): boolean {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const ua = userPart(na);
    const ub = userPart(nb);
    const sa = serverPart(na);
    const sb = serverPart(nb);
    return !!ua && ua === ub && !!sa && sa === sb;
}

function pickStoreName(db: IDBDatabase, candidates: string[]): string | null {
    const names = Array.from(db.objectStoreNames);
    for (const wanted of candidates) {
        if (names.includes(wanted)) return wanted;
    }
    const lower = names.map((n) => n.toLowerCase());
    for (const wanted of candidates) {
        const w = wanted.toLowerCase();
        const exact = lower.indexOf(w);
        if (exact >= 0) return names[exact];
        const idx = lower.findIndex((n) => n.includes(w) || w.includes(n));
        if (idx >= 0) return names[idx];
    }
    return null;
}

function openModelStorage(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
            // No version: open the current schema. Never upgrade/delete.
            req = indexedDB.open(DB_NAME);
        } catch (err) {
            reject(err);
            return;
        }
        req.onerror = () => {
            reject(req.error || new Error('Failed to open IndexedDB model-storage'));
        };
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (ev) => {
            if (ev.oldVersion === 0) {
                try {
                    req.transaction?.abort();
                } catch {
                    // ignore
                }
                reject(new Error('WhatsApp model-storage is missing. Open https://web.whatsapp.com first.'));
            }
        };
    });
}

function getAllFromStore(db: IDBDatabase, storeName: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error(`Failed to read store ${storeName}`));
        } catch (err) {
            reject(err);
        }
    });
}

async function readStore(db: IDBDatabase, candidates: string[]): Promise<unknown[]> {
    const name = pickStoreName(db, candidates);
    if (!name) return [];
    try {
        return await getAllFromStore(db, name);
    } catch {
        return [];
    }
}

function getVisibleGroupTitle(): string | null {
    const selectors = [
        '#main header span[dir="auto"][title]',
        '#main header span[title]',
        '#main header span[dir="auto"]',
        'header span[dir="auto"][title]',
        'header span[title]',
        'header span[dir="auto"]'
    ];
    for (const sel of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) continue;
        const raw = el.getAttribute('title') || el.textContent || '';
        const t = normalizeText(raw);
        if (t) return t;
    }
    const styled = document.querySelectorAll("header span[style*='height']:not(.copyable-text)");
    if (styled.length === 1 && styled[0].textContent) {
        const t = normalizeText(styled[0].textContent);
        if (t) return t;
    }
    return null;
}

function chatWid(chat: IdRecord): string {
    return serializeId(chat.id) || serializeId(chat._id) || '';
}

function isGroupChat(chat: IdRecord): boolean {
    const id = chatWid(chat);
    if (id.endsWith('@g.us')) return true;
    if (chat.isGroup === true) return true;
    if (chat.kind === 'group') return true;
    return false;
}

function chatDisplayName(chat: IdRecord): string {
    const fields = [chat.name, chat.formattedTitle, chat.subject, chat.displayedTitle];
    for (const f of fields) {
        if (typeof f === 'string' && normalizeText(f)) return normalizeText(f);
    }
    return '';
}

function chatTimestamp(chat: IdRecord): number {
    const fields = [
        chat.t,
        chat.timestamp,
        chat.lastMessageRecvTimestamp,
        chat.msgTimestamp,
        chat.conversationTimestamp
    ];
    for (const f of fields) {
        const n = Number(f);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
}

function titleScore(header: string, name: string): number {
    const h = normalizeText(header);
    const n = normalizeText(name);
    if (!h || !n) return 0;
    if (h === n) return 1000 + n.length;
    if (n.includes(h) || h.includes(n)) return 100 + Math.min(h.length, n.length);
    return 0;
}

function metaSubject(meta: IdRecord): string {
    const fields = [meta.subject, meta.name, meta.formattedTitle];
    for (const f of fields) {
        if (typeof f === 'string' && normalizeText(f)) return normalizeText(f);
    }
    return '';
}

function metaWid(meta: IdRecord): string {
    return serializeId(meta.id) || serializeId(meta._id) || serializeId(meta.groupId) || '';
}

function resolveGroup(
    chats: IdRecord[],
    metas: IdRecord[],
    headerTitle: string | null
): ResolvedGroup | null {
    const groups = chats.filter(isGroupChat);
    const metaById = new Map<string, IdRecord>();
    for (const meta of metas) {
        const id = metaWid(meta);
        if (id) metaById.set(id, meta);
    }

    const enriched = groups.map((chat) => {
        const id = chatWid(chat);
        const meta = metaById.get(id);
        const name = chatDisplayName(chat) || (meta ? metaSubject(meta) : '');
        return { id, name, t: chatTimestamp(chat), chat };
    }).filter((g) => g.id);

    if (enriched.length === 0) {
        // group-metadata only (no chat store / no @g.us chats)
        const fromMeta = metas
            .map((meta) => ({
                id: metaWid(meta),
                name: metaSubject(meta),
                t: Number(meta.t || meta.creation || 0) || 0
            }))
            .filter((g) => g.id.endsWith('@g.us') || g.id);
        if (fromMeta.length === 0) return null;
        return pickBest(fromMeta, headerTitle);
    }

    return pickBest(enriched, headerTitle);
}

function pickBest(
    groups: Array<{ id: string; name: string; t: number }>,
    headerTitle: string | null
): ResolvedGroup | null {
    if (groups.length === 0) return null;

    if (headerTitle) {
        let best: { id: string; name: string; t: number; score: number } | null = null;
        for (const g of groups) {
            const score = titleScore(headerTitle, g.name);
            if (score <= 0) continue;
            if (
                !best ||
                score > best.score ||
                (score === best.score && g.t > best.t)
            ) {
                best = { ...g, score };
            }
        }
        if (best) {
            return { id: best.id, name: best.name || headerTitle, usedFallback: false, fallbackReason: '' };
        }
    }

    const withTs = groups.filter((g) => g.t > 0).sort((a, b) => b.t - a.t);
    const chosen = withTs[0] || groups[0];
    const reason = headerTitle
        ? 'no header match; used most recently active group'
        : (withTs[0] ? 'used most recently active group' : 'used first group chat');
    return {
        id: chosen.id,
        name: chosen.name || chosen.id,
        usedFallback: true,
        fallbackReason: reason
    };
}

function extractParticipant(value: unknown): ParticipantRef | null {
    if (typeof value === 'string' || typeof value === 'number') {
        const id = String(value);
        return id ? { id } : null;
    }
    const rec = asRecord(value);
    if (!rec) return null;
    const id =
        serializeId(rec.id) ||
        serializeId(rec.wid) ||
        serializeId(rec.jid) ||
        serializeId(rec.participant) ||
        (typeof rec.user === 'string' && typeof rec.server === 'string'
            ? `${rec.user}@${rec.server}`
            : '');
    if (!id) return null;
    const nameFields = [rec.name, rec.pushname, rec.verifiedName, rec.shortName];
    let name = '';
    for (const f of nameFields) {
        if (typeof f === 'string' && normalizeText(f)) {
            name = normalizeText(f);
            break;
        }
    }
    return {
        id,
        isAdmin: !!(rec.isAdmin || rec.isSuperAdmin),
        name: name || undefined
    };
}

function flattenParticipants(value: unknown): ParticipantRef[] {
    const out: ParticipantRef[] = [];
    const seen = new Set<string>();
    const add = (p: ParticipantRef | null) => {
        if (!p || !p.id || seen.has(p.id)) return;
        seen.add(p.id);
        out.push(p);
    };

    if (typeof value === 'string' || typeof value === 'number') {
        add(extractParticipant(value));
        return out;
    }
    const arr = asArray(value);
    if (arr.length > 0) {
        for (const item of arr) add(extractParticipant(item));
        return out;
    }
    const rec = asRecord(value);
    if (!rec) return out;
    if (rec.participants != null) {
        return flattenParticipants(rec.participants);
    }
    add(extractParticipant(rec));
    return out;
}

function collectParticipants(
    groupId: string,
    chats: IdRecord[],
    participantRows: IdRecord[],
    metas: IdRecord[]
): ParticipantRef[] {
    const out: ParticipantRef[] = [];
    const seen = new Set<string>();
    const addAll = (items: ParticipantRef[]) => {
        for (const p of items) {
            if (!p.id || seen.has(p.id)) continue;
            seen.add(p.id);
            out.push(p);
        }
    };

    for (const row of participantRows) {
        const rowGroup =
            serializeId(row.groupId) ||
            (serializeId(row.id).endsWith('@g.us') ? serializeId(row.id) : '');
        if (rowGroup && idsEqual(rowGroup, groupId)) {
            if (row.participants != null) {
                addAll(flattenParticipants(row.participants));
            } else {
                // inverted membership row: groupId + one participant
                const one = extractParticipant(row);
                if (one && !idsEqual(one.id, groupId)) addAll([one]);
            }
            continue;
        }
        // Some schemas key the row by group id
        if (idsEqual(serializeId(row.id), groupId) && row.participants != null) {
            addAll(flattenParticipants(row.participants));
        }
    }

    for (const chat of chats) {
        if (!idsEqual(chatWid(chat), groupId)) continue;
        if (chat.participants != null) addAll(flattenParticipants(chat.participants));
        if (chat.groupMetadata != null) {
            const gm = asRecord(chat.groupMetadata);
            if (gm && gm.participants != null) addAll(flattenParticipants(gm.participants));
        }
    }

    for (const meta of metas) {
        if (!idsEqual(metaWid(meta), groupId)) continue;
        if (meta.participants != null) addAll(flattenParticipants(meta.participants));
        if (meta.participantsList != null) addAll(flattenParticipants(meta.participantsList));
    }

    return out;
}

function contactKeys(contact: IdRecord): string[] {
    const keys: string[] = [];
    const add = (v: unknown) => {
        const s = serializeId(v);
        if (!s) return;
        keys.push(s);
        const u = userPart(s);
        if (u) keys.push(u);
    };
    add(contact.id);
    add(contact._id);
    add(contact.wid);
    add(contact.jid);
    add(contact.phoneNumber);
    add(contact.lid);
    add(contact.lidJid);
    add(contact.pnJid);
    if (typeof contact.user === 'string') keys.push(contact.user);
    return keys;
}

function buildContactIndex(contacts: IdRecord[]): Map<string, IdRecord> {
    const index = new Map<string, IdRecord>();
    for (const contact of contacts) {
        for (const key of contactKeys(contact)) {
            const existing = index.get(key);
            if (!existing) {
                index.set(key, contact);
            } else {
                // Prefer the record that has a phoneNumber / name
                const existingPhone = serializeId(existing.phoneNumber);
                const nextPhone = serializeId(contact.phoneNumber);
                const existingName = typeof existing.name === 'string' ? existing.name : '';
                const nextName = typeof contact.name === 'string' ? contact.name : '';
                if ((!existingPhone && nextPhone) || (!existingName && nextName)) {
                    index.set(key, { ...existing, ...contact });
                }
            }
        }
    }
    return index;
}

function lookupContact(index: Map<string, IdRecord>, participantId: string): IdRecord | undefined {
    const id = normalizeText(participantId);
    if (!id) return undefined;
    return index.get(id) || index.get(userPart(id));
}

function plusFromContact(contact: IdRecord | undefined): boolean {
    if (!contact) return false;
    const fields = [contact.phoneNumber, contact.e164, contact.number, contact.formattedPhone];
    for (const f of fields) {
        if (typeof f === 'string' && f.includes('+')) return true;
    }
    return false;
}

function digitsFromCus(wid: string): string {
    const user = userPart(wid);
    const cleaned = user.replace(BIDI_AND_SPACE, '');
    if (/^\+?\d{6,15}$/.test(cleaned)) {
        return cleaned.replace(/^\+/, '');
    }
    const only = user.replace(/\D/g, '');
    return only.length >= 6 && only.length <= 15 ? only : '';
}

function phoneFromContactField(value: unknown): string {
    const s = serializeId(value);
    if (!s) return '';
    if (s.endsWith('@c.us')) return digitsFromCus(s);
    if (s.endsWith('@lid') || s.endsWith('@g.us') || s.endsWith('@s.whatsapp.net')) return '';
    if (isPhoneNumber(s)) return s.replace(BIDI_AND_SPACE, '').replace(/^\+/, '');
    return '';
}

function resolvePhone(participantId: string, contact: IdRecord | undefined): string {
    const id = normalizeText(participantId);
    let phone = '';
    if (id.endsWith('@c.us')) {
        phone = digitsFromCus(id);
    } else if (id.endsWith('@lid')) {
        if (contact) {
            phone =
                phoneFromContactField(contact.phoneNumber) ||
                phoneFromContactField(contact.id) ||
                phoneFromContactField(contact.pnJid) ||
                phoneFromContactField(contact.e164);
            // Only accept @c.us-backed phones for LID rows
            const pn = serializeId(contact.phoneNumber);
            const cid = serializeId(contact.id);
            if (!pn.endsWith('@c.us') && !cid.endsWith('@c.us') && !serializeId(contact.pnJid).endsWith('@c.us')) {
                if (!phoneFromContactField(contact.phoneNumber) && !phoneFromContactField(contact.e164)) {
                    phone = '';
                }
            }
        }
    } else {
        phone = digitsFromCus(id) || phoneFromContactField(id);
    }

    if (!phone && contact) {
        phone =
            phoneFromContactField(contact.phoneNumber) ||
            (serializeId(contact.id).endsWith('@c.us') ? digitsFromCus(serializeId(contact.id)) : '');
    }

    if (!phone) return '';
    if (plusFromContact(contact)) return `+${phone.replace(/^\+/, '')}`;
    return phone.replace(/^\+/, '');
}

function contactName(contact: IdRecord | undefined, fallback?: string): string {
    if (contact) {
        const fields = [contact.name, contact.pushname, contact.verifiedName, contact.shortName];
        for (const f of fields) {
            if (typeof f === 'string' && normalizeText(f)) return normalizeText(f);
        }
    }
    return fallback ? normalizeText(fallback) : '';
}

function contactPushname(contact: IdRecord | undefined): string {
    if (contact && typeof contact.pushname === 'string') {
        return normalizeText(contact.pushname);
    }
    return '';
}

function joinMembers(
    participants: ParticipantRef[],
    contacts: IdRecord[],
    source: string
): MemberRow[] {
    const index = buildContactIndex(contacts);
    const rows: MemberRow[] = [];
    const seen = new Set<string>();

    for (const p of participants) {
        const contact = lookupContact(index, p.id);
        const phone = resolvePhone(p.id, contact);
        const name = contactName(contact, p.name);
        const pushname = contactPushname(contact);
        const id = normalizeText(p.id);
        const key = phone || id;
        if (!key || seen.has(key)) {
            // If we already stored a LID-only row and now have a phone, upgrade it
            if (phone && id && seen.has(id)) {
                const existing = rows.find((r) => r.id === id && !r.phoneNumber);
                if (existing) {
                    existing.phoneNumber = phone;
                    seen.add(phone);
                }
            }
            continue;
        }
        seen.add(key);
        if (phone) seen.add(phone);
        if (id) seen.add(id);
        rows.push({
            phoneNumber: phone,
            name,
            pushname,
            source,
            id,
            isAdmin: p.isAdmin
        });
    }
    return rows;
}

function rowToCsvLine(row: Array<string | number | null | undefined>): string {
    let line = '';
    for (let i = 0; i < row.length; i++) {
        const cell = row[i];
        let value = (cell === null || cell === undefined) ? '' : cell.toString();
        value = value.replace(/"/g, '""');
        if (value.search(/("|,|\n)/g) >= 0) {
            value = '"' + value + '"';
        }
        if (i > 0) line += ',';
        line += value;
    }
    return line + '\n';
}

function exportToCsvWithBom(filename: string, rows: Array<Array<string | number | null | undefined>>): void {
    let csvFile = '';
    for (let i = 0; i < rows.length; i++) {
        csvFile += rowToCsvLine(rows[i]);
    }
    const blob = new Blob(['\uFEFF' + csvFile], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
}

function membersToCsv(rows: MemberRow[]): Array<Array<string>> {
    const out: Array<Array<string>> = [
        ['Phone Number', 'Name', 'Pushname', 'Source', 'Id']
    ];
    for (const row of rows) {
        out.push([
            row.phoneNumber,
            row.name,
            row.pushname,
            row.source,
            row.id
        ]);
    }
    return out;
}

async function exportGroupMembers(): Promise<{ group: ResolvedGroup; count: number }> {
    const db = await openModelStorage();
    try {
        const [chatRows, participantRows, contactRows, metaRows] = await Promise.all([
            readStore(db, CHAT_STORE_CANDIDATES),
            readStore(db, PARTICIPANT_STORE_CANDIDATES),
            readStore(db, CONTACT_STORE_CANDIDATES),
            readStore(db, GROUP_META_STORE_CANDIDATES)
        ]);

        const chats = chatRows.map(asRecord).filter((r): r is IdRecord => !!r);
        const participantsStore = participantRows.map(asRecord).filter((r): r is IdRecord => !!r);
        const contacts = contactRows.map(asRecord).filter((r): r is IdRecord => !!r);
        const metas = metaRows.map(asRecord).filter((r): r is IdRecord => !!r);

        const headerTitle = getVisibleGroupTitle();
        const group = resolveGroup(chats, metas, headerTitle);
        if (!group) {
            throw new Error('No group chat found in model-storage. Open a group on WhatsApp Web, then Export.');
        }

        const participants = collectParticipants(group.id, chats, participantsStore, metas);
        const members = joinMembers(participants, contacts, group.name);
        const timestamp = new Date().toISOString();
        exportToCsvWithBom(`${EXPORT_PREFIX}-${timestamp}.csv`, membersToCsv(members));
        return { group, count: members.length };
    } finally {
        try {
            db.close();
        } catch {
            // ignore
        }
    }
}

function setDirLtr(widget: UIContainer): void {
    widget.inner.setAttribute('dir', 'ltr');
    widget.canva.setAttribute('dir', 'ltr');
}

function buildWidget(): void {
    const uiWidget = new UIContainer();
    const statusEl = document.createElement('div');
    statusEl.setAttribute('style', [
        'text-align: left;',
        'background: #f5f5fa;',
        'padding: 8px 10px;',
        'margin-bottom: 8px;',
        'border-radius: 8px;',
        'font-family: monospace;',
        'font-size: 14px;',
        'line-height: 1.35;',
        'max-width: 420px;',
        'white-space: normal;',
        'color: #2f2f2f;',
        'box-shadow: rgba(42, 35, 66, 0.2) 0 2px 2px, rgba(45, 35, 66, 0.2) 0 7px 13px -4px;'
    ].join(''));
    statusEl.textContent = DEFAULT_STATUS;
    uiWidget.history.appendChild(statusEl);

    const setStatus = (text: string) => {
        statusEl.textContent = text;
    };

    const formatFound = (group: ResolvedGroup, count: number): string => {
        const base = `Found ${count} members in ${group.name}`;
        return group.usedFallback ? `${base} (${group.fallbackReason})` : base;
    };

    let exporting = false;
    const runExport = async () => {
        if (exporting) return;
        exporting = true;
        setStatus('Reading IndexedDB…');
        try {
            const { group, count } = await exportGroupMembers();
            setStatus(formatFound(group, count));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setStatus(message || 'Export failed');
            console.error(err);
        } finally {
            exporting = false;
        }
    };

    const btnExport = createCta();
    btnExport.appendChild(createTextSpan('Export'));
    btnExport.addEventListener('click', () => {
        void runExport();
    });
    uiWidget.addCta(btnExport);

    uiWidget.addCta(createSpacer());

    const btnReset = createCta();
    btnReset.appendChild(createTextSpan('Reset'));
    btnReset.addEventListener('click', () => {
        setStatus(DEFAULT_STATUS);
    });
    uiWidget.addCta(btnReset);

    uiWidget.makeItDraggable();
    uiWidget.render();
    setDirLtr(uiWidget);

    void runExport();
}

buildWidget();
