import {
    ListStorage,
    UIContainer,
    createCta,
    createSpacer,
    createTextSpan,
    HistoryTracker,
    LogCategory
} from 'browser-scraping-utils';

interface WhatsAppMember {
    profileId: string
    name?: string
    description?: string
    phoneNumber?: string
    source?: string
}

const BIDI_AND_SPACE = /[\s\-\(\)\.\u00a0\u202f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function stripBidi(text: string): string {
    return text.replace(BIDI_MARKS, '');
}

function isPhoneNumber(text: string): boolean {
    const stripped = text.replace(BIDI_AND_SPACE, '');
    return /^\+?\d{6,15}$/.test(stripped);
}

function cleanName(name: string): string {
    return name.trim().replace(/^~\s*/u, '').replace(BIDI_MARKS, '').trim();
}

function looksLikeName(text: string): boolean {
    const t = stripBidi(text).trim();
    if (!t) return false;
    if (t.startsWith('~')) return true;
    // Any letter in any script (Hebrew, Arabic, CJK, Latin, …)
    return /[\p{L}]/u.test(t);
}

function cleanDescription(description: string): string | null {
    const descriptionClean = stripBidi(description).trim();
    if (!descriptionClean) return null;

    const latinPlaceholders: RegExp[] = [
        /^loading(\s+about)?(\.{0,3})?$/i,
        /^(hey there!?\s*)?i am using whatsapp\.?$/i,
        /^available$/i,
        /^cargando(\s+\w+)?(\.{0,3})?$/i,
        /^(¡?hola!?\s*)?estoy usando whatsapp\.?$/i,
        /^disponible$/i,
        /^carregando(\s+\w+)?(\.{0,3})?$/i,
        /^(oi,?\s*(eu\s+)?)?estou usando o?\s*whatsapp\.?$/i,
        /^disponível$/i,
        /^chargement(\b.*)?(\.{0,3})?$/i,
        /^(salut\s*!?\s*)?j['’]utilise whatsapp\.?$/i,
        /^disponible$/i,
        /^wird geladen(\.{0,3})?$/i,
        /^(hallo!?\s*)?ich benutze whatsapp\.?$/i,
        /^verfügbar$/i,
        /^caricamento(\.{0,3})?$/i,
        /^(ciao!?\s*)?sto usando whatsapp\.?$/i,
        /^disponibile$/i,
        /^(привет!?\s*)?я использую whatsapp\.?$/i,
        /^доступен$/i,
        /^(merhaba!?\s*)?whatsapp kullan(ıyorum|iyorum)\.?$/i,
        /^müsait$/i,
        /^(halo!?\s*)?saya menggunakan whatsapp\.?$/i,
        /^(嗨[！!]?\s*)?我正在使用 whatsapp$/,
    ];

    for (const re of latinPlaceholders) {
        if (re.test(descriptionClean)) return null;
    }

    // Hebrew / Arabic: exact-enough (do not rely on case folding)
    const rtlPlaceholders: RegExp[] = [
        /^טוען(\s+.*)?$/,
        /^(היי[!,]?\s*)?אני משתמש(ת)? ב-?WhatsApp$/,
        /^זמינ[הן]$/,
        /^جاري التحميل/,
        /^(مرحبا!?\s*)?أنا أستخدم (واتساب|WhatsApp)$/,
        /^متاح$/,
        /^Я использую WhatsApp$/,
        /^Доступен$/,
        /^我正在使用 WhatsApp$/,
    ];

    for (const re of rtlPlaceholders) {
        if (re.test(descriptionClean)) return null;
    }

    return descriptionClean;
}

function rowToCsvLine(row: Array<string | number | null | undefined | Date>): string {
    let line = '';
    for (let i = 0; i < row.length; i++) {
        const cell = row[i];
        let value = (cell === null || cell === undefined) ? '' : cell.toString();
        if (cell instanceof Date) {
            value = cell.toLocaleString();
        }
        value = value.replace(/"/g, '""');
        if (value.search(/("|,|\n)/g) >= 0) {
            value = '"' + value + '"';
        }
        if (i > 0) line += ',';
        line += value;
    }
    return line + '\n';
}

// Local exporter: same quoting as browser-scraping-utils, but UTF-8 with BOM for Excel.
function exportToCsvWithBom(filename: string, rows: Array<Array<string | number | null | undefined | Date>>): void {
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
    }
}

function findModalElem(root: ParentNode | Document = document): HTMLElement | null {
    const animate = root.querySelector('[data-animate-modal-body="true"]') as HTMLElement | null;
    if (animate) return animate;

    const dialogs = root.querySelectorAll<HTMLElement>('div[role="dialog"]');
    for (const dialog of Array.from(dialogs)) {
        if (dialog.querySelector('[role="listitem"]')) {
            return dialog;
        }
    }
    if (dialogs.length === 1) return dialogs[0];
    return null;
}

function nodeIsOrContainsModal(htmlNode: HTMLElement): boolean {
    if (!htmlNode || htmlNode.nodeType !== 1) return false;
    const matches = typeof htmlNode.matches === 'function'
        ? htmlNode.matches.bind(htmlNode)
        : () => false;
    if (matches('[data-animate-modal-body="true"]')) return true;
    if (matches('div[role="dialog"]')) return true;
    if (typeof htmlNode.querySelector !== 'function') return false;
    if (htmlNode.querySelector('[data-animate-modal-body="true"]')) return true;
    if (htmlNode.querySelector('div[role="dialog"]')) return true;
    return false;
}

function getGroupSourceName(): string | null {
    const groupNameNode = document.querySelectorAll("header span[style*='height']:not(.copyable-text)");
    if (groupNameNode.length === 1 && groupNameNode[0].textContent) {
        return stripBidi(groupNameNode[0].textContent).trim() || null;
    }
    const dirAuto = document.querySelector<HTMLElement>('header span[dir="auto"][title]');
    if (dirAuto) {
        const t = dirAuto.getAttribute('title') || dirAuto.textContent;
        if (t && t.trim()) return stripBidi(t).trim();
    }
    const titleSpan = document.querySelector<HTMLElement>('header span[title]');
    if (titleSpan) {
        const t = titleSpan.getAttribute('title') || titleSpan.textContent;
        if (t && t.trim()) return stripBidi(t).trim();
    }
    return null;
}

function getListItemTitle(listItem: HTMLElement): { text: string; el: HTMLElement } | null {
    const titleSpan =
        listItem.querySelector<HTMLElement>('[data-testid="cell-frame-title"] span[title]') ||
        listItem.querySelector<HTMLElement>('span[title]') ||
        listItem.querySelector<HTMLElement>('span[dir="auto"]');
    if (!titleSpan) return null;
    const text = stripBidi(titleSpan.getAttribute('title') || titleSpan.textContent || '').trim();
    if (!text) return null;
    return { text, el: titleSpan };
}

function collectCandidates(listItem: HTMLElement): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (s: string | null | undefined) => {
        const v = stripBidi(s || '').trim();
        if (!v || seen.has(v)) return;
        seen.add(v);
        out.push(v);
    };
    listItem.querySelectorAll('span[title]').forEach((el) => {
        add(el.getAttribute('title'));
        add(el.textContent);
    });
    listItem.querySelectorAll('span[dir="auto"]').forEach((el) => {
        add(el.getAttribute('title'));
        add(el.textContent);
    });
    listItem.querySelectorAll('[role="gridcell"]').forEach((el) => {
        add(el.textContent);
    });
    return out;
}

function normalizeFoundPhone(text: string): string {
    const cleaned = stripBidi(text).replace(BIDI_AND_SPACE, '');
    return isPhoneNumber(cleaned) ? cleaned : '';
}

const WID_CUS_RE = /(\d{6,15})@c\.us/;
const WID_NON_PHONE_RE = /@(lid|g\.us|s\.whatsapp\.net|broadcast)\b/;

function phoneFromWidText(text: string): string {
    if (!text) return '';
    const stripped = stripBidi(text);
    // LIDs / group / broadcast ids are not phone numbers
    if (WID_NON_PHONE_RE.test(stripped) && !WID_CUS_RE.test(stripped)) return '';
    const m = stripped.match(WID_CUS_RE);
    return m ? m[1] : '';
}

function phoneFromWidObject(obj: Record<string, unknown>): string {
    const server = obj.server;
    if (
        server === 'lid' ||
        server === 'g.us' ||
        server === 's.whatsapp.net' ||
        server === 'broadcast'
    ) {
        return '';
    }
    if (typeof obj._serialized === 'string') {
        const fromSer = phoneFromWidText(obj._serialized);
        if (fromSer) return fromSer;
    }
    if (server === 'c.us' && obj.user != null) {
        const fromUser = normalizeFoundPhone(String(obj.user));
        if (fromUser) return fromUser;
    }
    return '';
}

const PHONE_FIELD_NAMES = new Set(['phonenumber', 'phone', 'e164', 'number']);

function phoneFromNamedField(key: string, value: unknown): string {
    if (!PHONE_FIELD_NAMES.has(key.toLowerCase())) return '';
    if (typeof value === 'string' || typeof value === 'number') {
        return normalizeFoundPhone(String(value));
    }
    return '';
}

function scanAttrsAndTextForPhone(listItem: HTMLElement): string {
    const telLink = listItem.querySelector<HTMLAnchorElement>('a[href^="tel:"]');
    if (telLink) {
        const href = telLink.getAttribute('href') || '';
        const fromTel = normalizeFoundPhone(href.replace(/^tel:/i, ''));
        if (fromTel) return fromTel;
    }

    const nodes: Element[] = [listItem, ...Array.from(listItem.querySelectorAll('*'))];
    for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        for (const attr of Array.from(node.attributes)) {
            const val = attr.value || '';
            const fromWid = phoneFromWidText(val);
            if (fromWid) return fromWid;
        }
    }

    const namedAttrs = ['data-id', 'data-testid', 'href', 'aria-label', 'title', 'alt'];
    const consider = (el: Element | null) => {
        if (!el || !(el instanceof HTMLElement)) return '';
        for (const name of namedAttrs) {
            const val = el.getAttribute(name);
            if (!val) continue;
            const fromWid = phoneFromWidText(val);
            if (fromWid) return fromWid;
            if (name !== 'data-testid') {
                const fromPhone = normalizeFoundPhone(val);
                if (fromPhone) return fromPhone;
            }
        }
        return '';
    };

    for (const node of nodes) {
        const direct = consider(node);
        if (direct) return direct;
        if (node.hasAttribute('data-testid')) {
            const parent = node.parentElement;
            if (parent) {
                for (const sib of Array.from(parent.children)) {
                    const fromSib = consider(sib);
                    if (fromSib) return fromSib;
                }
            }
        }
    }

    const fromText = phoneFromWidText(listItem.textContent || '');
    if (fromText) return fromText;
    return '';
}

function readReactRoots(el: Element): unknown[] {
    const roots: unknown[] = [];
    try {
        const rec = el as unknown as Record<string, unknown>;
        for (const key of Object.keys(rec)) {
            if (
                key.startsWith('__reactFiber') ||
                key.startsWith('__reactProps') ||
                key.startsWith('__reactInternalInstance')
            ) {
                roots.push(rec[key]);
            }
        }
    } catch {
        // ignore exotic host objects
    }
    return roots;
}

const FIBER_SKIP_KEYS = new Set([
    'sibling',
    'return',
    'alternate',
    '_debugOwner',
    '_debugSource',
    '_debugNeedsRemount',
    '_debugHookTypes',
    'parentNode',
    'parentElement',
    'ownerDocument',
    'nextSibling',
    'previousSibling'
]);

function walkReactForPhone(
    value: unknown,
    depth: number,
    seen: Set<unknown>,
    nameHint?: string,
    requireName?: boolean,
    nameSeen: boolean = false
): string {
    if (value == null || depth > 10) return '';
    if (typeof value === 'string') {
        if (requireName && !nameSeen) return '';
        return phoneFromWidText(value);
    }
    if (typeof value !== 'object') return '';
    if (value instanceof Node || value instanceof Window) return '';
    if (seen.has(value)) return '';
    seen.add(value);

    const rec = value as Record<string, unknown>;
    // Name may sit on this object (contact.name) while the Wid is nested (contact.id)
    const nameHere = !requireName || nameSeen || objectMentionsName(rec, nameHint, 1);

    const fromWidObj = phoneFromWidObject(rec);
    if (fromWidObj && nameHere) return fromWidObj;

    try {
        for (const key of Object.keys(rec)) {
            const fromField = phoneFromNamedField(key, rec[key]);
            if (fromField && nameHere) return fromField;
        }
    } catch {
        return '';
    }

    try {
        for (const key of Object.keys(rec)) {
            if (FIBER_SKIP_KEYS.has(key)) continue;
            const found = walkReactForPhone(
                rec[key],
                depth + 1,
                seen,
                nameHint,
                requireName,
                nameHere
            );
            if (found) return found;
        }
    } catch {
        return '';
    }
    return '';
}

function objectMentionsName(
    obj: Record<string, unknown>,
    nameHint?: string,
    extraDepth: number = 0
): boolean {
    if (!nameHint) return false;
    const needle = nameHint.trim();
    if (!needle) return false;
    try {
        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (typeof val === 'string' && stripBidi(val).includes(needle)) return true;
            if (
                extraDepth > 0 &&
                val &&
                typeof val === 'object' &&
                !(val instanceof Node) &&
                objectMentionsName(val as Record<string, unknown>, nameHint, extraDepth - 1)
            ) {
                return true;
            }
        }
    } catch {
        return false;
    }
    return false;
}

function collectFiberHostNodes(listItem: HTMLElement): HTMLElement[] {
    const nodes: HTMLElement[] = [listItem];
    const children = listItem.querySelectorAll('*');
    const childLimit = Math.min(children.length, 24);
    for (let i = 0; i < childLimit; i++) {
        const child = children[i];
        if (child instanceof HTMLElement) nodes.push(child);
    }
    let ancestor = listItem.parentElement;
    for (let i = 0; i < 2 && ancestor; i++) {
        nodes.push(ancestor);
        ancestor = ancestor.parentElement;
    }
    return nodes;
}

function scanReactForPhone(listItem: HTMLElement, nameHint?: string): string {
    const hosts = collectFiberHostNodes(listItem);
    const seen = new Set<unknown>();

    // List item + children: this row's own fiber/props (do not require name match)
    const ownHosts = hosts.filter((el) => el === listItem || listItem.contains(el));
    for (const host of ownHosts) {
        for (const root of readReactRoots(host)) {
            const found = walkReactForPhone(root, 0, seen, nameHint, false);
            if (found) return found;
        }
    }

    // A couple of ancestors: require the row name nearby so we do not
    // pick a sibling member's Wid out of the virtualized list fiber.
    const ancestorHosts = hosts.filter((el) => el !== listItem && !listItem.contains(el));
    for (const host of ancestorHosts) {
        for (const root of readReactRoots(host)) {
            const found = walkReactForPhone(root, 0, seen, nameHint, !!nameHint);
            if (found) return found;
        }
    }
    return '';
}

function findHiddenPhone(listItem: HTMLElement, nameHint?: string): string {
    const fromAttrs = scanAttrsAndTextForPhone(listItem);
    if (fromAttrs) return fromAttrs;
    const fromFiber = scanReactForPhone(listItem, nameHint);
    if (fromFiber) return fromFiber;
    return '';
}

function findSecondaryDescription(
    listItem: HTMLElement,
    titleEl: HTMLElement | null,
    name: string,
    phone: string
): string {
    const dedicated = listItem.querySelector<HTMLElement>(
        '[data-testid="cell-frame-secondary"] [data-testid="selectable-text"]'
    );
    if (dedicated && dedicated.textContent) {
        const desc = cleanDescription(dedicated.textContent);
        if (desc && desc !== name && desc !== phone) return desc;
    }

    const dirAutos = Array.from(listItem.querySelectorAll<HTMLElement>('span[dir="auto"]'));
    for (const el of dirAutos) {
        if (titleEl && (el === titleEl || titleEl.contains(el) || el.contains(titleEl))) continue;
        if (el.closest('[data-testid="cell-frame-title"]')) continue;
        const text = stripBidi(el.getAttribute('title') || el.textContent || '').trim();
        if (!text) continue;
        if (isPhoneNumber(text)) continue;
        if (name && (text === name || cleanName(text) === name)) continue;
        const desc = cleanDescription(text);
        if (desc && desc !== name && desc !== phone) return desc;
    }
    return '';
}

class WhatsAppStorage extends ListStorage<WhatsAppMember> {
    // In-memory source of truth. ListStorage IDB is optional cache only:
    // once IDB opens, parent getCount/getAll/toCsvData ignore this.data,
    // and a failed IDB put still returns true (so the history log fires
    // while Download stays at 0). persistent:false is also ignored unless truthy.
    localItems = new Map<string, WhatsAppMember>();

    get headers() {
        return [
            'Phone Number',
            'Name',
            'Description',
            'Source'
        ]
    }
    itemToRow(item: WhatsAppMember): string[]{
        return [
            item.phoneNumber ? item.phoneNumber : "",
            item.name ? item.name : "",
            item.description ? item.description : "",
            item.source ? item.source : ""
        ]
    }

    async addElem(
        identifier: string,
        elem: WhatsAppMember,
        updateExisting: boolean = false,
        groupId?: string
    ): Promise<boolean> {
        const existing = this.localItems.get(identifier);
        const merged = (updateExisting && existing)
            ? { ...existing, ...elem }
            : (existing && !updateExisting ? existing : elem);
        this.localItems.set(identifier, merged);
        try {
            await super.addElem(identifier, elem, updateExisting, groupId);
        } catch {
            // IDB is optional cache; ignore quota / origin failures
        }
        return true;
    }

    async getCount(): Promise<number> {
        return this.localItems.size;
    }

    async getAll(): Promise<Map<string, WhatsAppMember>> {
        return this.localItems;
    }

    async getElem(identifier: string): Promise<WhatsAppMember | undefined> {
        return this.localItems.get(identifier);
    }

    async clear(): Promise<void> {
        this.localItems.clear();
        try {
            await super.clear();
        } catch {
            // ignore IDB clear failures
        }
    }

    async toCsvData(): Promise<string[][]> {
        const rows: string[][] = [];
        rows.push(this.headers);
        this.localItems.forEach((item) => {
            try {
                rows.push(this.itemToRow(item));
            } catch (err) {
                console.error(err);
            }
        });
        return rows;
    }
}

const memberListStore = new WhatsAppStorage({
    name: "whatsapp-scraper"
});
const counterId = 'scraper-number-tracker'
const exportName = 'whatsAppExport';
let logsTracker: HistoryTracker;

async function updateConter(){
    // Update member tracker counter from in-memory map (never empty IDB)
    const tracker = document.getElementById(counterId)
    if(tracker){
        tracker.textContent = memberListStore.localItems.size.toString()
    }
}

const uiWidget = new UIContainer();

function buildCTABtns(){
    // History Tracker
    logsTracker = new HistoryTracker({
        onDelete: async (groupId: string) => {
            // We dont have cancellable adds for now
            console.log(`Delete ${groupId}`);
            await memberListStore.deleteFromGroupId(groupId);
            await updateConter();
        },
        divContainer: uiWidget.history,
        maxLogs: 4
    })

    // Button Download
    const btnDownload = createCta();
    btnDownload.appendChild(createTextSpan('Download\u00A0'))
    btnDownload.appendChild(createTextSpan('0', {
        bold: true,
        idAttribute: counterId
    }))
    btnDownload.appendChild(createTextSpan('\u00A0users'))

    btnDownload.addEventListener('click', async function() {
        const timestamp = new Date().toISOString()
        const data = await memberListStore.toCsvData()
        try{
            exportToCsvWithBom(`${exportName}-${timestamp}.csv`, data)
        }catch(err){
            console.error('Error while generating export');
            // @ts-ignore
            console.log(err.stack)
        }
    });

    uiWidget.addCta(btnDownload)

    // Spacer
    uiWidget.addCta(createSpacer())

    // Button Reinit
    const btnReinit = createCta();
    btnReinit.appendChild(createTextSpan('Reset'))
    btnReinit.addEventListener('click', async function() {
        await memberListStore.clear();
        logsTracker.cleanLogs();
        await updateConter();
    });
    uiWidget.addCta(btnReinit);

    // Draggable
    uiWidget.makeItDraggable();

    // Render
    uiWidget.render()

    // Keep overlay LTR so it stays usable on RTL WhatsApp Web (Hebrew, Arabic)
    const widgetAny = uiWidget as any;
    if (widgetAny.inner && widgetAny.inner.setAttribute) {
        widgetAny.inner.setAttribute('dir', 'ltr');
    }
    if (widgetAny.canva && widgetAny.canva.setAttribute) {
        widgetAny.canva.setAttribute('dir', 'ltr');
    }

    // Initial
    window.setTimeout(()=>{
        updateConter()
    }, 1000)
}

let modalObserver: MutationObserver | undefined;
let modalRescanTimer: number | undefined;
let modalScrollTimer: number | undefined;

function findScrollableContainer(modal: HTMLElement): HTMLElement | null {
    const listItem = modal.querySelector<HTMLElement>('[role="listitem"]');
    if (listItem) {
        let el: HTMLElement | null = listItem.parentElement;
        while (el && (modal.contains(el) || el === modal)) {
            if (el.scrollHeight > el.clientHeight + 4) {
                return el;
            }
            el = el.parentElement;
        }
    }

    let best: HTMLElement | null = null;
    let bestOverflow = 0;
    const candidates = [modal, ...Array.from(modal.querySelectorAll<HTMLElement>('*'))];
    for (const el of candidates) {
        const extra = el.scrollHeight - el.clientHeight;
        if (extra <= bestOverflow) continue;
        const style = window.getComputedStyle(el);
        const oy = style.overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay' || oy === 'hidden') {
            best = el;
            bestOverflow = extra;
        }
    }
    return best;
}

function stopAutoScroll(completed: boolean = false){
    if (modalScrollTimer != null) {
        window.clearInterval(modalScrollTimer);
        modalScrollTimer = undefined;
        if (completed && logsTracker) {
            logsTracker.addHistoryLog({
                label: "Scroll complete",
                category: LogCategory.LOG
            });
        }
    }
}

function startAutoScroll(modalElem: HTMLElement){
    stopAutoScroll(false);

    let attempts = 0;
    const tryStart = () => {
        if (!modalElem.isConnected) return;
        const scroller = findScrollableContainer(modalElem);
        if (!scroller) {
            attempts += 1;
            if (attempts < 15) {
                window.setTimeout(tryStart, 400);
            }
            return;
        }

        logsTracker.addHistoryLog({
            label: "Auto-scroll…",
            category: LogCategory.LOG
        });

        const stepPx = 120;
        const tickMs = 400;
        const maxRoundTrips = 24;
        const stagnantRoundTripsToStop = 3;
        let direction = 1;
        let lastCount = -1;
        let stagnantRoundTrips = 0;
        let completedRoundTrips = 0;
        let passedBottom = false;
        let settling = false;

        void memberListStore.getCount().then((c) => {
            lastCount = c;
        });

        modalScrollTimer = window.setInterval(() => {
            if (!modalElem.isConnected || !scroller.isConnected) {
                stopAutoScroll(false);
                return;
            }

            const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            if (maxScroll < 8) {
                return;
            }

            scroller.scrollTop += direction * stepPx;

            const atBottom = scroller.scrollTop >= maxScroll - 2;
            const atTop = scroller.scrollTop <= 2;

            if (direction === 1 && atBottom) {
                direction = -1;
                passedBottom = true;
            } else if (direction === -1 && atTop && passedBottom) {
                direction = 1;
                passedBottom = false;
                if (settling) return;
                settling = true;
                void (async () => {
                    try {
                        const count = await memberListStore.getCount();
                        completedRoundTrips += 1;
                        if (count === lastCount) {
                            stagnantRoundTrips += 1;
                        } else {
                            lastCount = count;
                            stagnantRoundTrips = 0;
                        }
                        if (
                            stagnantRoundTrips >= stagnantRoundTripsToStop ||
                            completedRoundTrips >= maxRoundTrips
                        ) {
                            stopAutoScroll(true);
                        }
                    } finally {
                        settling = false;
                    }
                })();
            }
        }, tickMs);
    };

    window.setTimeout(tryStart, 300);
}

function listenModalChanges(){
    // Restart cleanly if the body observer re-fires while a modal is already open
    if (modalObserver || modalRescanTimer != null || modalScrollTimer != null) {
        stopListeningModalChanges();
    }

    const source = getGroupSourceName();

    const modalElem = findModalElem();
    if(!modalElem) return;

    // Session-wide dedupe: survives virtualized node recycling (where fresh DOM nodes
    // re-display already-scraped contacts as the user scrolls back)
    const scrapedIds = new Set<string>();

    const extractFromListItem = async (listItem: HTMLElement) => {
        // [data-testid="cell-frame-container"] is optional (WhatsApp has been removing it)

        const titleInfo = getListItemTitle(listItem);
        if (!titleInfo) return;
        const titleText = titleInfo.text;
        if (!titleText) return;

        let profileName = "";
        let profilePhone = "";

        if (titleText.startsWith('~')) {
            profileName = cleanName(titleText);
        } else if (isPhoneNumber(titleText)) {
            profilePhone = titleText;
        } else if (looksLikeName(titleText)) {
            profileName = cleanName(titleText);
        }

        const candidates = collectCandidates(listItem);
        for (const candidate of candidates) {
            if (isPhoneNumber(candidate)) {
                if (!profilePhone) profilePhone = candidate;
                continue;
            }
            if (candidate.startsWith('~')) {
                if (!profileName) profileName = cleanName(candidate);
                continue;
            }
            if (!profileName && looksLikeName(candidate) && candidate !== titleText) {
                const maybeDesc = cleanDescription(candidate);
                // Prefer leftover letter-strings as name only when title was a phone
                if (isPhoneNumber(titleText) && maybeDesc) {
                    profileName = cleanName(candidate);
                }
            }
        }

        // Never put a non-phone string in phoneNumber
        if (profilePhone && !isPhoneNumber(profilePhone)) {
            if (!profileName && looksLikeName(profilePhone)) {
                profileName = cleanName(profilePhone);
            }
            profilePhone = "";
        }

        // Named contacts: WhatsApp hides the number in the row; recover it
        // from tel:/WID attributes or React fiber contact props.
        if (!profilePhone) {
            const hidden = findHiddenPhone(listItem, profileName);
            if (hidden && isPhoneNumber(hidden)) {
                profilePhone = hidden;
            }
        }

        if (!profileName && !profilePhone) return;

        // Storage key: phone if present, else name. If a name-only row was
        // already stored, update THAT pk instead of inserting a phone-keyed duplicate.
        let identifier = profilePhone || profileName;
        const alreadyByPhone = !!(profilePhone && scrapedIds.has(profilePhone));
        const alreadyByName = !!(profileName && scrapedIds.has(profileName));
        if (alreadyByPhone) return;
        if (alreadyByName && !profilePhone) return;
        if (profilePhone && profileName) {
            if (alreadyByName) {
                identifier = profileName;
            } else {
                const existingByName = await memberListStore.getElem(profileName);
                if (existingByName && !existingByName.phoneNumber) {
                    identifier = profileName;
                }
            }
        }

        scrapedIds.add(identifier);
        if (profilePhone) scrapedIds.add(profilePhone);
        if (profileName) scrapedIds.add(profileName);

        const profileDescription = findSecondaryDescription(
            listItem,
            titleInfo.el,
            profileName,
            profilePhone
        );

        const data: WhatsAppMember = {
            profileId: identifier
        };
        if (profilePhone) data.phoneNumber = profilePhone;
        if (source) data.source = source;
        if (profileName) data.name = profileName;
        if (profileDescription) data.description = profileDescription;

        await memberListStore.addElem(identifier, data, true);
        logsTracker.addHistoryLog({
            label: `Scraping ${profileName || profilePhone}`,
            category: LogCategory.LOG
        });
        updateConter();
    };

    const handleNode = (el: HTMLElement) => {
        let items: HTMLElement[] = [];
        if (el.getAttribute && el.getAttribute('role') === 'listitem') {
            items = [el];
        } else if (el.querySelectorAll) {
            items = Array.from(el.querySelectorAll<HTMLElement>('[role="listitem"]'));
        }

        items.forEach(listItem => {
            // Synchronous guard: key data-scraped by current title so recycled virtualized
            // nodes re-scrape when their content changes, but same-mutation duplicates are dropped.
            const titleInfo = getListItemTitle(listItem);
            const titleText = titleInfo ? titleInfo.text : '';
            if (!titleText) return;
            if (listItem.getAttribute('data-scraped') === titleText) return;
            listItem.setAttribute('data-scraped', titleText);

            window.setTimeout(() => extractFromListItem(listItem), 10);
        });
    };

    const callback = (mutationList: MutationRecord[]) => {
        let rescanModal = false;
        for (const mutation of mutationList) {
            if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1) handleNode(node as HTMLElement);
                });
            } else if (mutation.type === "attributes" && mutation.attributeName === "data-scraped") {
                continue;
            } else if (mutation.type === "attributes" || mutation.type === "characterData") {
                // Recycled virtualized rows often keep the same node and only
                // change title/text — re-scan every current listitem.
                rescanModal = true;
            }
        }
        if (rescanModal) {
            handleNode(modalElem as HTMLElement);
        }
    };

    // Initial pass for items already rendered when the observer attaches
    handleNode(modalElem as HTMLElement);

    modalObserver = new MutationObserver(callback);
    modalObserver.observe(modalElem, {
        childList: true,
        attributes: true,
        characterData: true,
        subtree: true
    });

    // Safety net: virtualization can update titles without a childList add
    modalRescanTimer = window.setInterval(() => {
        if (!modalElem.isConnected) {
            stopListeningModalChanges();
            return;
        }
        handleNode(modalElem as HTMLElement);
    }, 500);

    startAutoScroll(modalElem as HTMLElement);
}



function stopListeningModalChanges(){
    if(modalObserver){
        modalObserver.disconnect();
        modalObserver = undefined;
    }
    if (modalRescanTimer != null) {
        window.clearInterval(modalRescanTimer);
        modalRescanTimer = undefined;
    }
    stopAutoScroll(false);
}


function main(): void {
    buildCTABtns();


    logsTracker.addHistoryLog({
        label: "Wait for modal",
        category: LogCategory.LOG
    })

    function bodyCallback(
        mutationList: MutationRecord[],
        // observer: MutationObserver
    ){
        for (const mutation of mutationList) {
            // console.log(mutation)
            if (mutation.type === "childList") {
                if(mutation.addedNodes.length>0){
                    mutation.addedNodes.forEach((node)=>{
                        if (node.nodeType !== 1) return;
                        const htmlNode = node as HTMLElement
                        if(nodeIsOrContainsModal(htmlNode)){
                            window.setTimeout(()=>{
                                listenModalChanges();

                                logsTracker.addHistoryLog({
                                    label: "Modal found - Scroll to scrape",
                                    category: LogCategory.LOG
                                })
                            }, 10)
                        }
                    })
                }
                if(mutation.removedNodes.length>0){
                    mutation.removedNodes.forEach((node)=>{
                        if (node.nodeType !== 1) return;
                        const htmlNode = node as HTMLElement
                        if(nodeIsOrContainsModal(htmlNode)){
                            stopListeningModalChanges();
                            logsTracker.addHistoryLog({
                                label: "Modal Removed - Scraping Stopped",
                                category: LogCategory.LOG
                            })
                        }
                    })
                }
            }
        }
    }

    const bodyConfig = { attributes: true, childList: true, subtree: true };
    const bodyObserver = new MutationObserver(bodyCallback);

    // Start observing the target node for configured mutations
    const app = document.getElementById('app');
    if(app){
        bodyObserver.observe(app, bodyConfig);
    }
}

main();
