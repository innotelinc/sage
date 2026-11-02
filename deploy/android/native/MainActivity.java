package us.innotel.sage;

import android.os.Bundle;

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
}
