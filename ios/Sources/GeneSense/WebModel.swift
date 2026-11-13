import AuthenticationServices
import SwiftUI
import VisionKit
import WebKit

/// Owns the web view that shows https://genesense-five.vercel.app and the bridge the page talks to.
///
/// Page to app: `window.gsNative.scan()` (document scanner, resolves to a JPEG Blob or null),
/// `window.gsNative.scanQR()` (device QR code, resolves to its text or null),
/// `window.gsNative.authSession(url)` (Google sign-in sheet, resolves to the genesense:// link or null) and `window.print()`.
/// Everything else is the normal web app; the page knows it runs here by the `ios-app` class on <html>.
@MainActor
final class WebModel: NSObject, ObservableObject {
    static let home = URL(string: "https://genesense-five.vercel.app/")!

    @Published var ready = false
    @Published var offline = false
    let webView: WKWebView
    let ble = Bluetooth()
    private var scanner: Scanner?
    private var signIn: ASWebAuthenticationSession?
    private var downloads: [ObjectIdentifier: URL] = [:]

    override init() {
        let config = WKWebViewConfiguration()
        config.limitsNavigationsToAppBoundDomains = true
        config.applicationNameForUserAgent = "GeneSenseiOS/1.3"   // 1.1: inline camera video; 1.2: native QR scanner; 1.3: Google sign-in sheet
        config.allowsInlineMediaPlayback = true      // the QR scanner's camera view plays inside the page
        let scripts = WKUserContentController()
        scripts.addUserScript(WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = scripts
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        // ponytail: the content controller keeps this model alive; fine while it lives as long as the app.
        scripts.add(self, name: "gsNative")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor(Theme.background)
        webView.scrollView.backgroundColor = UIColor(Theme.background)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        ble.run = { [weak self] script in self?.webView.evaluateJavaScript(script, completionHandler: nil) }
        webView.load(URLRequest(url: Self.home))
        // Never keep the launch mark up longer than this on a slow network.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.ready = true }
    }

    func reload() {
        offline = false
        if webView.url == nil { webView.load(URLRequest(url: Self.home)) } else { webView.reload() }
    }

    private func topController() -> UIViewController? {
        var top = webView.window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    private func scan(id: Int) {
        guard VNDocumentCameraViewController.isSupported, let top = topController() else { return finishScan(id, nil) }
        let scanner = Scanner { [weak self] jpeg in self?.finishScan(id, jpeg) }
        self.scanner = scanner
        let camera = VNDocumentCameraViewController()
        camera.delegate = scanner
        top.present(camera, animated: true)
    }

    private func scanQR(id: Int) {
        guard let top = topController() else { return resolveText(id, nil) }
        top.present(QRScanner { [weak self] text in self?.resolveText(id, text) }, animated: true)
    }

    private func resolveText(_ id: Int, _ text: String?) {
        let value = text.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: .fragmentsAllowed) }
            .flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        webView.evaluateJavaScript("window.gsNative._resolve(\(id), \(value))", completionHandler: nil)
    }

    /// Google refuses sign-in inside a web view, so it runs in Apple's sign-in sheet. The sheet closes when the server
    /// sends it to genesense://auth?..., and that link (a one-time code) goes back to the page.
    private func authSession(id: Int, url: String) {
        guard let start = URL(string: url), start.host == Self.home.host else { return resolveText(id, nil) }
        let session = ASWebAuthenticationSession(url: start, callbackURLScheme: "genesense") { [weak self] back, _ in
            DispatchQueue.main.async {
                self?.signIn = nil
                self?.resolveText(id, back?.absoluteString)
            }
        }
        session.presentationContextProvider = self
        signIn = session
        if !session.start() { signIn = nil; resolveText(id, nil) }
    }

    private func finishScan(_ id: Int, _ jpeg: Data?) {
        scanner = nil
        let value = jpeg.map { "\"" + $0.base64EncodedString() + "\"" } ?? "null"
        webView.evaluateJavaScript("window.gsNative._resolve(\(id), \(value))", completionHandler: nil)
    }

    private func printPage() {
        let printer = UIPrintInteractionController.shared
        printer.printFormatter = webView.viewPrintFormatter()
        _ = printer.present(animated: true)
    }

    private func share(_ url: URL) {
        topController()?.present(UIActivityViewController(activityItems: [url], applicationActivities: nil), animated: true)
    }

    private static let bridge = """
    (() => {
      const mark = () => document.documentElement && document.documentElement.classList.add("ios-app");
      mark();
      const pending = new Map();
      let next = 0;
      const post = message => window.webkit.messageHandlers.gsNative.postMessage(message);
      const call = (type, extra = {}) => new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        post({ type, id, ...extra });
      });
      const take = id => { const waiting = pending.get(id); pending.delete(id); return waiting; };
      window.gsNative = {
        scan: () => call("scan").then(base64 => base64 ? new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: "image/jpeg" }) : null),
        // scanQR() resolves to the QR code's text (or a typed code), or null when closed.
        scanQR: () => call("scanQR"),
        // authSession(url) opens Google sign-in; resolves to the genesense://auth?... link, or null when closed.
        authSession: url => call("auth", { url }),
        // ble.connect(pairs) resolves to { name, services } once subscribed; then events reach ble.onevent.
        ble: { connect: pairs => call("ble.connect", { pairs }), disconnect: () => post({ type: "ble.disconnect" }), onevent: null },
        _resolve(id, value) { take(id)?.resolve(value); },
        _reject(id, name, message) { const waiting = take(id); if (waiting) waiting.reject(Object.assign(new Error(message), { name })); },
        _ble(event) { window.gsNative.ble.onevent?.(event); }
      };
      window.print = () => post({ type: "print" });
      addEventListener("DOMContentLoaded", () => {
        mark();
        // App feel: no zoom when a form field gets focus; the page fills the screen under the Dynamic Island.
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) viewport.content += ", maximum-scale=1, viewport-fit=cover";
      });
    })();
    """
}

extension WebModel: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "scan": scan(id: body["id"] as? Int ?? 0)
        case "scanQR": scanQR(id: body["id"] as? Int ?? 0)
        case "auth": authSession(id: body["id"] as? Int ?? 0, url: body["url"] as? String ?? "")
        case "print": printPage()
        case "ble.connect": ble.connect(id: body["id"] as? Int ?? 0, pairs: body["pairs"] as? [[String: String]] ?? [])
        case "ble.disconnect": ble.disconnect()
        default: break
        }
    }
}

extension WebModel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if action.shouldPerformDownload { return .download }
        guard let url = action.request.url else { return .cancel }
        if url.host == Self.home.host || ["about", "blob", "data"].contains(url.scheme ?? "") { return .allow }
        // Other sites, phone numbers and mail open in their own apps.
        await UIApplication.shared.open(url)
        return .cancel
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        offline = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    private func failed(_ error: Error) {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled else { return }
        offline = true
        ready = true
    }
}

extension WebModel: WKUIDelegate {
    /// Links with target="_blank" open in Safari instead of being dropped.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    /// The page may use the camera (the device QR scanner) without a second web prompt; iOS still asks once.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .camera ? .grant : .deny)
    }
}

extension WebModel: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        webView.window ?? ASPresentationAnchor()
    }
}

extension WebModel: WKDownloadDelegate {
    /// Saved files ("Lưu ảnh") land in a temporary file, then the share sheet offers Save Image, Files, AirDrop.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(suggestedFilename)
        try? FileManager.default.removeItem(at: url)
        downloads[ObjectIdentifier(download)] = url
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { share(url) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
    }
}
