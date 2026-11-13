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
    ]

    /// Whether this phone could be charged at all, and where it is signed in.
    ///
    /// A product StoreKit refuses to return and an Apple ID that may not pay look
    /// identical from the page — an empty list and a dead button — so the two facts
    /// the device can state are reported rather than inferred.
    @objc func diagnostics(_ call: CAPPluginCall) {
        Task {
            let storefront = await Storefront.current
            call.resolve([
                "canMakePayments": AppStore.canMakePayments(),
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
                    // finishing here would lose a paid session if the mint failed.
                    call.resolve([
                        "transactionId": String(transaction.id),
                        "productId": transaction.productID,
                        "signedTransaction": signed,
                        "json": transaction.jsonRepresentation.base64EncodedString(),
                    ])
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
