import {
    exportToCsv,
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


function cleanName(name: string): string{
    const nameClean = name.trim()
    return nameClean.replace('~ ', '')
}

function cleanDescription(description: string) : string | null {
    const descriptionClean = description.trim()
    if(
        !descriptionClean.match(/Loading About/i) &&
        !descriptionClean.match(/I am using WhatsApp/i) &&
        !descriptionClean.match(/Available/i)
    ){
        return descriptionClean
    }
    return null;
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
            exportToCsv(`${exportName}-${timestamp}.csv`, data)
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

    // Initial
    window.setTimeout(()=>{
        updateConter()
    }, 1000)
}

let modalObserver: MutationObserver;

function listenModalChanges(){
    const groupNameNode = document.querySelectorAll("header span[style*='height']:not(.copyable-text)")
    let source: string | null = null;
    if(groupNameNode.length==1){
        source = groupNameNode[0].textContent
    }

    const modalElem = document.querySelector('[data-animate-modal-body="true"]');
    if(!modalElem) return;

    // Session-wide dedupe: survives virtualized node recycling (where fresh DOM nodes
    // re-display already-scraped contacts as the user scrolls back)
    const scrapedIds = new Set<string>();

    const extractFromListItem = async (listItem: HTMLElement) => {
        if (!listItem.querySelector('[data-testid="cell-frame-container"]')) return;

        const titleSpan = listItem.querySelector<HTMLElement>('[data-testid="cell-frame-title"] span[title]');
        if (!titleSpan) return;
        const titleText = (titleSpan.getAttribute('title') || '').trim();
        if (!titleText) return;

        let profileName = "";
        let profilePhone = "";

        if (titleText.startsWith('~')) {
            profileName = cleanName(titleText);
            const phoneSpan = listItem.querySelector<HTMLElement>('[role="gridcell"][aria-colindex="1"] span[dir="auto"]');
            if (phoneSpan && phoneSpan.textContent) {
                profilePhone = phoneSpan.textContent.trim();
            }
        } else {
            profilePhone = titleText;
        }

        if (!profileName && !profilePhone) return;
        const identifier = profilePhone || profileName;

        if (scrapedIds.has(identifier)) return;
        scrapedIds.add(identifier);

        let profileDescription = "";
        const descSpan = listItem.querySelector<HTMLElement>('[data-testid="cell-frame-secondary"] [data-testid="selectable-text"]');
        if (descSpan && descSpan.textContent) {
            const desc = cleanDescription(descSpan.textContent);
            if (desc) profileDescription = desc;
        }

        const data: WhatsAppMember = {
            profileId: identifier,
            phoneNumber: profilePhone || profileName
        };
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
            const titleSpan = listItem.querySelector<HTMLElement>('[data-testid="cell-frame-title"] span[title]');
            const titleText = titleSpan ? (titleSpan.getAttribute('title') || '').trim() : '';
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
                        const htmlNode = node as HTMLElement
                        const modalElems = htmlNode.querySelectorAll('[data-animate-modal-body="true"]');
                        if(modalElems.length>0){
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
                        const htmlNode = node as HTMLElement
                        const modalElems = htmlNode.querySelectorAll('[data-animate-modal-body="true"]');
                        if(modalElems.length>0){
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
