import Foundation
import Capacitor
import StoreKit

/// In-app purchase for the session keys.
///
/// Apple requires digital goods sold inside an iOS app to go through StoreKit, so
/// the purchase happens here and nowhere else on this platform. The plugin stops at
/// the signed transaction: the key is minted by the server, which checks Apple's
/// signature over that transaction before it mints, so a purchase made in a patched
/// client is worth nothing.
@objc(SageStorePlugin)
public class SageStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SageStorePlugin"
    public let jsName = "SageStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "buy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "diagnostics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
    ]

    private var updateTask: Task<Void, Never>?

    /// StoreKit 2 hands a purchase the sheets never returned here: Ask to Buy approved
    /// later, or a payment made on another device. The listener has to exist for the
    /// life of the app, so it starts with the plugin and stops with it.
    override public func load() {
        updateTask = Task { [weak self] in
            for await update in Transaction.updates {
                guard case .verified(let transaction) = update else { continue }
                self?.notifyListeners(
                    "purchaseUpdate",
                    data: Self.describe(transaction, signed: update.jwsRepresentation)
                )
            }
        }
    }

    deinit { updateTask?.cancel() }

    /// The shape the page already understands: an id, the product, and Apple's own
    /// signature over the transaction — never the page's word for any of it.
    private static func describe(_ transaction: Transaction, signed: String) -> [String: Any] {
        [
            "transactionId": String(transaction.id),
            "productId": transaction.productID,
            "signedTransaction": signed,
            "json": transaction.jsonRepresentation.base64EncodedString(),
        ]
    }

    /// What a consumable still owes: a purchase that was paid for but never finished,
    /// because the app was killed or the server was unreachable at the time.
    @objc func unfinished(_ call: CAPPluginCall) {
        Task {
            var rows: [[String: Any]] = []
            for await update in Transaction.unfinished {
                guard case .verified(let transaction) = update else { continue }
                rows.append(Self.describe(transaction, signed: update.jwsRepresentation))
            }
            call.resolve(["transactions": rows])
        }
    }

    /// Only the page knows when the server has minted the key, so only the page asks for
    /// this. An unfinished consumable is delivered again on every launch until it is.
    @objc func finish(_ call: CAPPluginCall) {
        guard let id = call.getString("transactionId"), let wanted = UInt64(id) else {
            call.reject("transactionId is required")
            return
        }
        Task {
            for await update in Transaction.unfinished {
                guard case .verified(let transaction) = update, transaction.id == wanted else { continue }
                await transaction.finish()
                call.resolve(["finished": true])
                return
            }
            call.resolve(["finished": false])
        }
    }

    /// Whether this phone could be charged at all, and where it is signed in.
    ///
    /// A product StoreKit refuses to return and an Apple ID that may not pay look
    /// identical from the page — an empty list and a dead button — so the two facts
    /// the device can state are reported rather than inferred.
    @objc func diagnostics(_ call: CAPPluginCall) {
        Task {
            let storefront = await Storefront.current
            call.resolve([
                "canMakePayments": AppStore.canMakePayments,
                "storefront": storefront?.countryCode ?? "",
            ])
        }
    }

    /// Prices come from the store, not from the page: App Store Connect is the
    /// price list the person is charged against.
    @objc func products(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        guard !ids.isEmpty else {
            call.resolve(["products": []])
            return
        }
        Task {
            do {
                let found = try await Product.products(for: ids)
                let list: [[String: Any]] = found.map { product in
                    [
                        "productId": product.id,
                        "title": product.displayName,
                        "price": product.displayPrice,
                    ]
                }
                call.resolve(["products": list])
            } catch {
                call.reject("Could not reach the App Store: \(error.localizedDescription)")
            }
        }
    }

    @objc func buy(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("productId is required")
            return
        }
        Task {
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    call.reject("That session is not available in the App Store yet.")
                    return
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    guard case .verified(let transaction) = verification else {
                        call.reject("Apple could not verify that purchase.")
                        return
                    }
                    // The JWS is Apple's own signature over this transaction, and the
                    // server checks it against Apple's root before minting. Nothing
                    // here decides whether a purchase is real: this is the evidence.
                    let signed = verification.jwsRepresentation
                    guard !signed.isEmpty else {
                        call.reject("The App Store did not sign that purchase.")
                        return
                    }
                    // A consumable is finished once the server has acknowledged it;
                    // finishing here would lose a paid session if the mint failed, so
                    // the page calls `finish` after the key exists.
                    call.resolve(Self.describe(transaction, signed: signed))
                case .userCancelled:
                    call.reject("Purchase cancelled.")
                case .pending:
                    call.reject("The purchase is waiting for approval.")
                @unknown default:
                    call.reject("The purchase did not complete.")
                }
            } catch {
                call.reject("Purchase failed: \(error.localizedDescription)")
            }
        }
    }
}
