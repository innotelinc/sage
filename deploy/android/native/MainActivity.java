package us.innotel.sage;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Capacitor only loads plugins listed in its generated registry; a plugin
        // that ships with the app itself has to be named here before the bridge
        // is built.
        registerPlugin(SageScreenPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPause() {
        super.onPause();
        // Frames keep arriving while another app is in front, and the page is what
        // reads them. Android pauses the WebView along with the activity, so the
        // capture would run with nobody listening — keep its timers alive.
        WebView view = getBridge() != null ? getBridge().getWebView() : null;
        if (view != null) view.resumeTimers();
    }
}
