package us.innotel.sage;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The bridge between the page and the capture service. Asking for the grant is
 * the only thing that needs an Activity; the capture itself lives in
 * SageScreenService so it survives the page going to the background.
 */
@CapacitorPlugin(name = "SageScreen")
public class SageScreenPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void start(PluginCall call) {
        if (SageScreenService.isRunning()) {
            JSObject already = new JSObject();
            already.put("running", true);
            call.resolve(already);
            return;
        }
        Context context = getContext();
        MediaProjectionManager manager =
                (MediaProjectionManager) context.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            call.reject("This device cannot capture the screen.");
            return;
        }
        startActivityForResult(call, manager.createScreenCaptureIntent(), "onProjectionGranted");
    }

    @ActivityCallback
    private void onProjectionGranted(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("Screen capture was not allowed.");
            return;
        }

        Intent service = new Intent(getContext(), SageScreenService.class);
        service.setAction(SageScreenService.ACTION_START);
        service.putExtra(SageScreenService.EXTRA_RESULT_CODE, result.getResultCode());
        service.putExtra(SageScreenService.EXTRA_RESULT_DATA, data);
        long interval = call.getLong("intervalMs", 1500L).longValue();
        service.putExtra(SageScreenService.EXTRA_INTERVAL_MS, interval);

        SageScreenService.setFrameListener((base64, width, height) -> {
            // notifyListeners from the capture thread would race the WebView's
            // message loop; the main thread already owns it.
            main.post(() -> {
                JSObject frame = new JSObject();
                frame.put("data", base64);
                frame.put("width", width);
                frame.put("height", height);
                notifyListeners("frame", frame);
            });
        });

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(service);
        } else {
            getContext().startService(service);
        }

        JSObject started = new JSObject();
        started.put("running", true);
        call.resolve(started);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        SageScreenService.setFrameListener(null);
        SageScreenService.stop(getContext());
        JSObject stopped = new JSObject();
        stopped.put("running", false);
        call.resolve(stopped);
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject state = new JSObject();
        state.put("running", SageScreenService.isRunning());
        call.resolve(state);
    }

    @Override
    protected void handleOnDestroy() {
        SageScreenService.setFrameListener(null);
        super.handleOnDestroy();
    }
}
