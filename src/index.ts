import {
    APIError,
    Base64u,
    Bytes,
    isInstanceOf,
    LinkSession,
    LinkStorage,
    LinkTransport,
    SessionError,
    SigningRequest,
} from '@bloks/link'

import { createQrCode } from '@bloks/qrcode'

import {fuel, compareVersion as fuelVersion} from './fuel'
import styleSelector from './styles'

const AbortPrepare = Symbol()
const SkipFee = Symbol()
const SkipToManual = Symbol()

export interface BrowserTransportOptions {
    /** CSS class prefix, defaults to `proton-link` */
    classPrefix?: string
    /** Whether to inject CSS styles in the page header, defaults to true. */
    injectStyles?: boolean
    /** Whether to display request success and error messages, defaults to true */
    requestStatus?: boolean
    /** Requesting account of the dapp (optional) */
    requestAccount?: string
    /** Wallet name e.g. proton, anchor, etc */
    walletType?: string
    /** Option to include back button in transport modal */
    backButton?: boolean
    /** Local storage prefix, defaults to `proton-link`. */
    storagePrefix?: string
    /**
     * Whether to use Greymass Fuel for low resource accounts, defaults to false.
     * Note that this service is not available on all networks.
     * Visit https://greymass.com/en/fuel for more information.
     */
    disableGreymassFuel?: boolean
    /**
     * The referring account to pass along to the Greymass Fuel API endpoint.
     * Specifying an account name will indicate to the API which account is eligible
     * to potentially receive a share of the fees generated by their application.
     */
    fuelReferrer?: string
    /**
     * Override of the supported resource provider chains.
     */
    supportedChains?: Record<string, string>
    /**
     * Set to false to not use !important styles, defaults to true.
     */
    importantStyles?: boolean
}

interface footNoteDownloadLinks {
    [key: string]: string
}

const footnoteLinks: footNoteDownloadLinks = {
    proton: 'https://protonchain.com/wallet',
    anchor: 'https://greymass.com/en/anchor/',
}

const defaultSupportedChains = {
    aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906: 'https://eos.greymass.com',
    '2a02a0053e5a8cf73a56ba0fda11e4d92e0238a4a2aa74fccf46d5a910746840':
        'https://jungle3.greymass.com',
    '4667b205c6838ef70ff7988f6e8257e8be0e1284a2f59699054a018f743b1d11':
        'https://telos.greymass.com',
    '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4': 'https://wax.greymass.com',
    '384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0':
        'https://proton.greymass.com',
}

interface DialogArgs {
    title: string | HTMLElement
    subtitle?: string | HTMLElement
    type?: string
    content?: HTMLElement
    action?: {text: string; callback: () => void}
    footnote?: string | HTMLElement,
    hideLogo?: boolean
}

class Storage implements LinkStorage {
    constructor(readonly keyPrefix: string) {}
    async write(key: string, data: string): Promise<void> {
        localStorage.setItem(this.storageKey(key), data)
    }
    async read(key: string): Promise<string | null> {
        return localStorage.getItem(this.storageKey(key))
    }
    async remove(key: string): Promise<void> {
        localStorage.removeItem(this.storageKey(key))
    }
    storageKey(key: string) {
        return `${this.keyPrefix}-${key}`
    }
}

export default class BrowserTransport implements LinkTransport {
    /** Package version. */
    static version = '__ver' // replaced by build script

    storage: LinkStorage

    constructor(public readonly options: BrowserTransportOptions = {}) {
        this.classPrefix = options.classPrefix || 'proton-link'
        this.injectStyles = !(options.injectStyles === false)
        this.importantStyles = !(options.importantStyles === false)
        this.requestStatus = !(options.requestStatus === false)
        this.requestAccount = options.requestAccount || ''
        this.walletType = options.walletType || 'proton'
        this.backButton = !(options.backButton === false)
        this.fuelEnabled = options.disableGreymassFuel !== true
        this.fuelReferrer = options.fuelReferrer || 'teamgreymass'
        this.storage = new Storage(options.storagePrefix || 'proton-link')
        this.supportedChains = options.supportedChains || defaultSupportedChains
    }

    private classPrefix: string
    private injectStyles: boolean
    private importantStyles: boolean
    private requestStatus: boolean
    private requestAccount: string
    private walletType: string
    private backButton: boolean
    private fuelEnabled: boolean
    private fuelReferrer: string
    private supportedChains: Record<string, string>
    private activeRequest?: SigningRequest
    private activeCancel?: (reason: string | Error) => void
    private containerEl!: HTMLElement
    private requestEl!: HTMLElement
    private styleEl?: HTMLStyleElement
    private font?: HTMLLinkElement
    private countdownTimer?: NodeJS.Timeout
    private closeTimer?: NodeJS.Timeout
    private prepareStatusEl?: HTMLElement

    private closeModal() {
        this.hide()
        if (this.activeCancel) {
            this.activeRequest = undefined
            this.activeCancel('Modal closed')
            this.activeCancel = undefined
        }
    }

    private setupElements() {
        if (this.injectStyles && !this.styleEl) {
            this.font = document.createElement('link')
            this.font.href = 'https://fonts.cdnfonts.com/css/circular-std-book'
            this.font.rel = 'stylesheet'
            this.styleEl = document.createElement('style')
            this.styleEl.type = 'text/css'
            const css = styleSelector(this.walletType).replace(/%prefix%/g, this.classPrefix)
            this.styleEl.appendChild(document.createTextNode(css))
            this.styleEl.appendChild(this.font)
            document.head.appendChild(this.styleEl)
        }
        if (!this.containerEl) {
            // Clear duplicate container
            const elements = document.getElementsByClassName(this.classPrefix)
            while (elements.length > 0) {
                elements[0].remove()
            }

            this.containerEl = this.createEl()
            this.containerEl.className = this.classPrefix
            this.containerEl.onclick = (event) => {
                if (event.target === this.containerEl) {
                    event.stopPropagation()
                    this.closeModal()
                }
            }
            document.body.appendChild(this.containerEl)
        }
        if (!this.requestEl) {
            const wrapper = this.createEl({class: 'inner'})
            const nav = this.createEl({class: 'nav'})
            const navHeader = this.createEl({
                class: 'header',
                tag: 'span',
                text: '',
            })
            if (this.backButton) {
                const backButton = this.createEl({class: 'back'})
                backButton.onclick = (event) => {
                    event.stopPropagation()
                    this.closeModal()
                    document.dispatchEvent(new CustomEvent('backToSelector'))
                }
                nav.appendChild(backButton)
            }
            const closeButton = this.createEl({class: 'close'})
            closeButton.onclick = (event) => {
                event.stopPropagation()
                this.closeModal()
            }
            this.requestEl = this.createEl({class: 'request'})
            nav.appendChild(navHeader)
            nav.appendChild(closeButton)
            wrapper.appendChild(nav)
            wrapper.appendChild(this.requestEl)
            this.containerEl.appendChild(wrapper)
        }
    }

    private createEl(attrs?: {[key: string]: any}): HTMLElement {
        if (!attrs) attrs = {}
        const el = document.createElement(attrs.tag || 'div')
        for (const attr of Object.keys(attrs)) {
            const value = attrs[attr]
            switch (attr) {
                case 'src':
                    el.setAttribute(attr, value)
                    break
                case 'tag':
                    break
                case 'content':
                    if (typeof value === 'string') {
                        el.appendChild(document.createTextNode(value))
                    } else {
                        el.appendChild(value)
                    }
                    break
                case 'text':
                    el.appendChild(document.createTextNode(value))
                    break
                case 'class':
                    el.className = `${this.classPrefix}-${value}`
                    break
                default:
                    el.setAttribute(attr, value)
            }
        }
        return el
    }

    private hide() {
        if (this.containerEl) {
            this.containerEl.classList.remove(`${this.classPrefix}-active`)
        }
        this.clearTimers()
    }

    private show() {
        if (this.containerEl) {
            this.containerEl.classList.add(`${this.classPrefix}-active`)
        }
    }

    private showDialog(args: DialogArgs) {
        this.setupElements()

        if (args.title) {
            let element = document.getElementsByClassName(`${this.classPrefix}-header`)[0]
            if (typeof args.title === 'string') {
                element.textContent = args.title
            } else {
                element = args.title
            }
        }

        emptyElement(this.requestEl)

        // if (!args.hideLogo) {
        //     const logoEl = this.createEl({class: 'logo'})
        //     if (args.type) {
        //         logoEl.classList.add(args.type)
        //     }
        //     this.requestEl.appendChild(logoEl)
        // }

        if (args.content) {
            this.requestEl.appendChild(args.content)
        }
        if (args.action) {
            const buttonEl = this.createEl({tag: 'a', class: 'button', text: args.action.text})
            buttonEl.addEventListener('click', (event) => {
                event.preventDefault()
                args.action!.callback()
            })
            this.requestEl.appendChild(buttonEl)
        }

        if (args.subtitle) {
            let subtitleEl
            if (typeof args.subtitle === 'string') {
                subtitleEl = this.createEl({class: 'subtitle', tag: 'span', text: args.subtitle})
            } else {
                subtitleEl = args.subtitle
            }
            this.requestEl.appendChild(subtitleEl)
        }

        if (args.footnote) {
            const footnoteEl = this.createEl({class: 'footnote', content: args.footnote})
            this.requestEl.appendChild(footnoteEl)
        }
        this.show()
    }

    private async displayRequest(request: SigningRequest) {
        const returnUrl = generateReturnUrl()

        const sameDeviceRequest = request.clone()
        sameDeviceRequest.setInfoKey('same_device', true)
        sameDeviceRequest.setInfoKey('return_path', returnUrl)

        if (this.requestAccount.length > 0) {
            request.setInfoKey('req_account', this.requestAccount)
            sameDeviceRequest.setInfoKey('req_account', this.requestAccount)
        }

        const sameDeviceUri = sameDeviceRequest.encode(true, false)
        const crossDeviceUri = request.encode(true, false)

        // Create QR
        const qrEl = this.createEl({
            tag: 'img',
            class: 'qr',
            src: await createQrCode(crossDeviceUri),
        })

        const svg = qrEl.querySelector('svg')
        if (svg) {
            svg.addEventListener('click', (event) => {
                event.preventDefault()
                qrEl.classList.toggle('zoom')
            })
        }

        const linkEl = this.createEl({class: 'uri'})
        const linkA = this.createEl({
            tag: 'a',
            class: 'button',
            href: sameDeviceUri,
            text: `Open Wallet`,
        })
        linkEl.appendChild(linkA)

        if (isFirefox() || isBrave()) {
            // this prevents firefox/brave from killing the websocket connection once the link is clicked
            const iframe = this.createEl({
                class: 'wskeepalive',
                src: 'about:blank',
                tag: 'iframe',
            })
            linkEl.appendChild(iframe)
            linkA.addEventListener('click', (event) => {
                event.preventDefault()
                iframe.setAttribute('src', sameDeviceUri)
            })
        } else {
            linkA.addEventListener('click', (event) => {
                event.preventDefault()
                window.location.href = sameDeviceUri
            })
        }

        const divider = this.createEl({class: 'separator', text: 'OR'})

        const backgroundEl = this.createEl({class: 'background'})
        backgroundEl.appendChild(qrEl)

        const actionEl = this.createEl({class: 'actions'})
        actionEl.appendChild(backgroundEl)

        // if (isMobile() || this.walletType == 'anchor') {
            actionEl.appendChild(divider)
            actionEl.appendChild(linkEl)
        // }

        let footnote: HTMLElement = this.createEl({class: 'footnote'})
        const isIdentity = request.isIdentity()
        if (isIdentity) {
            footnote = this.createEl({
                class: 'footnote',
                text: `Don't have a wallet? `,
            })
            const footnoteLink = this.createEl({
                tag: 'a',
                target: '_blank',
                href: footnoteLinks[this.walletType],
                text: 'Download it here',
            })
            footnote.appendChild(footnoteLink)
        }

        this.showDialog({
            title: 'Scan the QR-Code',
            footnote,
            content: actionEl,
        })
    }

    public async showLoading() {
        this.prepareStatusEl = this.createEl({
            tag: 'span',
            text: 'Preparing request...',
        })
        this.showDialog({
            title: 'Pending...',
            subtitle: this.prepareStatusEl.textContent!,
            type: 'loading',
        })
    }

    public onRequest(request: SigningRequest, cancel: (reason: string | Error) => void) {
        this.activeRequest = request
        this.activeCancel = cancel
        this.displayRequest(request).catch(cancel)
    }

    public onSessionRequest(
        session: LinkSession,
        request: SigningRequest,
        cancel: (reason: string | Error) => void
    ) {
        if (session.metadata.sameDevice) {
            request.setInfoKey('return_path', generateReturnUrl())
        }

        if (session.type === 'fallback') {
            this.onRequest(request, cancel)
            if (session.metadata.sameDevice) {
                // trigger directly on a fallback same-device session
                window.location.href = request.encode()
            }
            return
        }

        this.activeRequest = request
        this.activeCancel = cancel

        const timeout = session.metadata.timeout || 60 * 1000 * 2
        const deviceName = session.metadata.name

        // Create content
        const content = this.createEl({class: 'info'})

        // Content timer
        const start = Date.now()
        const countdown = this.createEl({class: 'countdown', tag: 'span', text: ''})
        const updateCountdown = () => {
            const timeLeft = timeout + start - Date.now()
            const timeFormatted =
                timeLeft > 0 ? new Date(timeLeft).toISOString().substr(14, 5) : '00:00'
            countdown.textContent = `${timeFormatted}`
        }
        this.countdownTimer = setInterval(updateCountdown, 500)
        updateCountdown()
        content.appendChild(countdown)

        // Content title
        const infoEl = this.createEl({class: 'info'})
        const infoTitle = this.createEl({class: 'title', tag: 'span', text: 'Confirm request'})
        infoEl.appendChild(infoTitle)
        content.appendChild(infoEl)

        // Content subtitle
        let subtitle: string
        if (deviceName && deviceName.length > 0) {
            subtitle = `Please open on "${deviceName}" to review and sign the transaction.`
        } else {
            subtitle = 'Please review and sign the transaction in the linked wallet.'
        }

        this.showDialog({
            title: 'Pending...',
            subtitle,
            content,
            hideLogo: true,
        })

        if (session.metadata.sameDevice) {
            // if (session.metadata.launchUrl) {
            //     window.location.href = session.metadata.launchUrl
            // } else
            if (isMobile()) {
                const scheme = request.getScheme()
                window.location.href = `${scheme}://link`
            }
        }
    }

    public sendSessionPayload(payload: Bytes, session: LinkSession): boolean {
        if (!session.metadata.triggerUrl || !session.metadata.sameDevice) {
            // not same device or no trigger url supported
            return false
        }
        if (payload.array.length > 700) {
            // url could be clipped by iOS
            return false
        }
        window.location.href = session.metadata.triggerUrl.replace(
            '%s',
            Base64u.encode(payload.array)
        )
        return true
    }

    private clearTimers() {
        if (this.closeTimer) {
            clearTimeout(this.closeTimer)
            this.closeTimer = undefined
        }
        if (this.countdownTimer) {
            clearTimeout(this.countdownTimer)
            this.countdownTimer = undefined
        }
    }

    private async showFee(request: SigningRequest, fee: string) {
        this.activeRequest = request
        const cancelPromise = new Promise((resolve, reject) => {
            this.activeCancel = (reason) => {
                let error: Error
                if (typeof reason === 'string') {
                    error = new Error(reason)
                } else {
                    error = reason
                }
                error[AbortPrepare] = true
                reject(error)
            }
        })

        const content = this.createEl({class: 'info'})
        const feePart1 = this.createEl({
            tag: 'span',
            text: 'You can try to ',
        })
        const feeBypass = this.createEl({
            tag: 'a',
            text: 'proceed without the fee',
        })
        const feePart2 = this.createEl({
            tag: 'span',
            text: ' or accept the fee shown below to pay for these costs.',
        })

        const feeDescription = this.createEl({
            class: 'subtitle',
            tag: 'span',
        })
        feeDescription.appendChild(feePart1)
        feeDescription.appendChild(feeBypass)
        feeDescription.appendChild(feePart2)
        content.appendChild(feeDescription)

        const expireEl = this.createEl({
            tag: 'span',
            class: 'subtitle',
            text: 'Offer expires in --:--',
        })
        content.appendChild(expireEl)

        const expires = request.getRawTransaction().expiration.toDate()
        const expireTimer = setInterval(() => {
            expireEl.textContent = `Offer expires in ${countdownFormat(expires)}`
            if (expires.getTime() < Date.now()) {
                this.activeCancel!('Offer expired')
            }
        }, 200)

        const footnote = this.createEl({
            tag: 'span',
            text: 'Resources offered by ',
        })
        const footnoteLink = this.createEl({
            tag: 'a',
            target: '_blank',
            href: 'https://greymass.com/en/fuel',
            text: 'Greymass Fuel',
        })
        footnote.appendChild(footnoteLink)

        const skipPromise = waitForEvent(feeBypass, 'click').then(() => {
            const error = new Error('Skipped fee')
            error[SkipFee] = true
            throw error
        })
        const confirmPromise = new Promise<void>((resolve) => {
            this.showDialog({
                title: 'Transaction Fee',
                subtitle:
                    'Your account lacks the network resources for this transaction and it cannot be covered for free.',
                type: 'fuel',
                content,
                action: {
                    text: `Accept Fee of ${fee}`,
                    callback: resolve,
                },
                footnote,
            })
        })

        await Promise.race([confirmPromise, skipPromise, cancelPromise]).finally(() => {
            clearInterval(expireTimer)
        })
    }

    public async prepare(request: SigningRequest, session?: LinkSession) {
        this.showLoading()
        if (!this.fuelEnabled || !session || request.isIdentity() || this.walletType === 'proton') {
            // don't attempt to cosign id request or if we don't have a session attached
            return request
        }
        if (
            typeof session.metadata.cosignerVersion === 'string' &&
            fuelVersion(session.metadata.cosignerVersion)
        ) {
            // if signer has cosigner, only attempt to cosign here if we have a newer version
            return request
        }
        try {
            const result = fuel(
                request,
                session,
                (message: string) => {
                    if (this.prepareStatusEl) {
                        this.prepareStatusEl.textContent = message
                    }
                },
                this.supportedChains,
                this.fuelReferrer
            )
            const timeout = new Promise((r) => setTimeout(r, 5000)).then(() => {
                throw new Error('API timeout after 5000ms')
            })
            const modified = await Promise.race([result, timeout])
            const fee = modified.getInfoKey('txfee')
            if (fee) {
                await this.showFee(modified, String(fee))
            }
            return modified
        } catch (error) {
            if ((error as any)[AbortPrepare]) {
                this.hide()
                throw error
            } else {
                // eslint-disable-next-line no-console
                console.info(`Skipping resource provider: ${(error as any).message || error}`)
                if ((error as any)[SkipFee]) {
                    const modified = request.clone()
                    modified.setInfoKey('no_fee', true, 'bool')
                    return modified
                }
            }
        }
        return request
    }

    public onSuccess(request: SigningRequest) {
        if (request === this.activeRequest) {
            this.clearTimers()
            if (this.requestStatus) {
                this.showDialog({
                    title: 'Success!',
                    subtitle: request.isIdentity() ? 'Login completed.' : 'Transaction signed.',
                    type: 'success',
                })
                this.closeTimer = setTimeout(() => {
                    this.hide()
                }, 1.5 * 1000)
            } else {
                this.hide()
            }
        }
    }

    public onFailure(request: SigningRequest, error: Error) {
        if (request === this.activeRequest && (error as any)['code'] !== 'E_CANCEL') {
            this.clearTimers()
            if (this.requestStatus) {
                let errorMessage: string
                if (isInstanceOf(error, APIError)) {
                    if (error.name === 'eosio_assert_message_exception') {
                        errorMessage = error.details[0].message
                    } else if (error.details.length > 0) {
                        errorMessage = error.details.map((d) => d.message).join('\n')
                    } else {
                        errorMessage = error.message
                    }
                } else {
                    errorMessage = (error as any).message || String(error)
                }
                this.showDialog({
                    title: 'Transaction Error',
                    subtitle: errorMessage,
                    type: 'error',
                })
            } else {
                this.hide()
            }
        } else {
            this.hide()
        }
    }

    public userAgent() {
        return `BrowserTransport/${BrowserTransport.version} ${navigator.userAgent}`
    }
}

function waitForEvent<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    eventName: K,
    timeout?: number
): Promise<HTMLElementEventMap[K]> {
    return new Promise((resolve, reject) => {
        const listener = (event: HTMLElementEventMap[K]) => {
            element.removeEventListener(eventName, listener)
            resolve(event)
        }
        element.addEventListener(eventName, listener)
        if (timeout) {
            setTimeout(() => {
                element.removeEventListener(eventName, listener)
                reject(new Error(`Timed out waiting for ${eventName}`))
            }, timeout)
        }
    })
}

function countdownFormat(date: Date) {
    const timeLeft = date.getTime() - Date.now()
    if (timeLeft > 0) {
        return new Date(timeLeft).toISOString().substr(14, 5)
    }
    return '00:00'
}

function emptyElement(el: HTMLElement) {
    while (el.firstChild) {
        el.removeChild(el.firstChild)
    }
}

/** Generate a return url that Anchor will redirect back to w/o reload. */
function generateReturnUrl() {
    if (isChromeiOS()) {
        // google chrome on iOS will always open new tab so we just ask it to open again as a workaround
        return 'googlechrome://'
    }
    if (isFirefoxiOS()) {
        // same for firefox
        return 'firefox:://'
    }
    if (isAppleHandheld() && isBrave()) {
        // and brave ios
        return 'brave://'
    }
    if (isAppleHandheld()) {
        // return url with unique fragment required for iOS safari to trigger the return url
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        let rv = window.location.href.split('#')[0] + '#'
        for (let i = 0; i < 8; i++) {
            rv += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
        }
        return rv
    }

    if (isAndroid() && isFirefox()) {
        return 'android-intent://org.mozilla.firefox'
    }

    if (isAndroid() && isEdge()) {
        return 'android-intent://com.microsoft.emmx'
    }

    if (isAndroid() && isOpera()) {
        return 'android-intent://com.opera.browser'
    }

    if (isAndroid() && isBrave()) {
        return 'android-intent://com.brave.browser'
    }

    if (isAndroid() && isAndroidWebView()) {
        return 'android-intent://webview'
    }

    if (isAndroid() && isChromeMobile()) {
        return 'android-intent://com.android.chrome'
    }

    return window.location.href
}

function isAppleHandheld() {
    return /iP(ad|od|hone)/i.test(navigator.userAgent)
}

function isChromeiOS() {
    return /CriOS/.test(navigator.userAgent)
}

function isChromeMobile() {
    return /Chrome\/[.0-9]* Mobile/i.test(navigator.userAgent)
}

function isFirefox() {
    return /Firefox/i.test(navigator.userAgent)
}

function isFirefoxiOS() {
    return /FxiOS/.test(navigator.userAgent)
}

function isOpera() {
    return /OPR/.test(navigator.userAgent) || /Opera/.test(navigator.userAgent)
}

function isEdge() {
    return /Edg/.test(navigator.userAgent)
}

function isBrave() {
    return navigator['brave'] && typeof navigator['brave'].isBrave === 'function'
}

function isAndroid() {
    return /Android/.test(navigator.userAgent)
}

function isAndroidWebView() {
    return /wv/.test(navigator.userAgent)
}

function isMobile() {
    return (
        typeof window.orientation !== 'undefined' || navigator.userAgent.indexOf('IEMobile') !== -1
    )
}