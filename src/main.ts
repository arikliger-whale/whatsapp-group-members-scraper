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
}

const memberListStore = new WhatsAppStorage({
    name: "whatsapp-scraper"
});
const counterId = 'scraper-number-tracker'
const exportName = 'whatsAppExport';
let logsTracker: HistoryTracker;

async function updateConter(){
    // Update member tracker counter
    const tracker = document.getElementById(counterId)
    if(tracker){
        const countValue = await memberListStore.getCount();
        tracker.textContent = countValue.toString()
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

let modalObserver: MutationObserver;

function listenModalChanges(){
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

        if (!profileName && !profilePhone) return;
        const identifier = profilePhone || profileName;

        if (scrapedIds.has(identifier)) return;
        scrapedIds.add(identifier);

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
        for (const mutation of mutationList) {
            if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1) handleNode(node as HTMLElement);
                });
            }
        }
    };

    // Initial pass for items already rendered when the observer attaches
    handleNode(modalElem as HTMLElement);

    modalObserver = new MutationObserver(callback);
    modalObserver.observe(modalElem, { childList: true, subtree: true });
}



function stopListeningModalChanges(){
    // Later, you can stop observing
    if(modalObserver){
        modalObserver.disconnect();
    }
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
