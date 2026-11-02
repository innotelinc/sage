import Foundation
import Capacitor
import StoreKit

/// In-app purchase for the session keys.
///
/// Apple requires digital goods sold inside an iOS app to go through StoreKit, so
/// the purchase happens here and nowhere else on this platform. The plugin stops
/// at a verified transaction id: the key is minted by the server, which checks the
/// transaction with Apple first, so a purchase made in a patched client is worth
/// nothing.
@objc(SageStorePlugin)
public class SageStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SageStorePlugin"
    public let jsName = "SageStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "buy", returnType: CAPPluginReturnPromise),
    ]

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
                    // A consumable is finished once the server has acknowledged it;
                    // finishing here would lose a paid session if the mint failed.
                    call.resolve([
                        "transactionId": String(transaction.id),
                        "productId": transaction.productID,
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
