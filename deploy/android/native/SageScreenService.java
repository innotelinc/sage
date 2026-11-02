package us.innotel.sage;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Screen capture that outlives the app being visible.
 *
 * A page's own capture ends when the browser leaves the foreground, which is
 * useless here: the exam is in another app. Android allows exactly one thing to
 * record while someone else owns the screen — a MediaProjection held by a
 * foreground service of type mediaProjection — so that is what this is. Frames
 * are scaled and JPEG-encoded on a background thread and handed up as base64,
 * because the sampling the app actually does is every few seconds, not every
 * frame the display produces.
 */
public class SageScreenService extends Service {

    public static final String ACTION_START = "us.innotel.sage.SCREEN_START";
    public static final String ACTION_STOP = "us.innotel.sage.SCREEN_STOP";
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";
    public static final String EXTRA_INTERVAL_MS = "intervalMs";

    private static final String CHANNEL_ID = "sage_screen";
    private static final int NOTIFICATION_ID = 4711;
    private static final int TARGET_WIDTH = 1000;
    private static final int JPEG_QUALITY = 72;
    private static final long DEFAULT_INTERVAL_MS = 1500;

    public interface FrameListener {
        void onFrame(String base64Jpeg, int width, int height);
    }

    private static volatile FrameListener listener;
    private static volatile boolean running;

    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader reader;
    private HandlerThread thread;
    private Handler handler;
    private long lastFrameAt;
    private long intervalMs = DEFAULT_INTERVAL_MS;

    public static void setFrameListener(FrameListener next) {
        listener = next;
    }

    public static boolean isRunning() {
        return running;
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, SageScreenService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        // Android 14 refuses getMediaProjection unless the service is already
        // foreground with the mediaProjection type, so this comes first.
        startInForeground();

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent data = resultData(intent);
        if (data == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        long asked = intent.getLongExtra(EXTRA_INTERVAL_MS, DEFAULT_INTERVAL_MS);
        intervalMs = Math.max(600, Math.min(10000, asked));
        begin(resultCode, data);
        return START_NOT_STICKY;
    }

    private static Intent resultData(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class);
        //noinspection deprecation
        return intent.getParcelableExtra(EXTRA_RESULT_DATA);
    }

    private void startInForeground() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel =
                    new NotificationChannel(CHANNEL_ID, "Screen watching", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while Sage is reading the screen.");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(
                this,
                0,
                open,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                        : PendingIntent.FLAG_UPDATE_CURRENT);

        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Sage is watching the screen")
                .setContentText("Keeps reading while you use another app.")
                .setSmallIcon(getApplicationInfo().icon)
                .setOngoing(true)
                .setContentIntent(tap)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void begin(int resultCode, Intent data) {
        if (projection != null) return;
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            stopSelf();
            return;
        }
        projection = manager.getMediaProjection(resultCode, data);
        if (projection == null) {
            stopSelf();
            return;
        }

        WindowManager windows = (WindowManager) getSystemService(WINDOW_SERVICE);
        DisplayMetrics metrics = new DisplayMetrics();
        if (windows != null && windows.getDefaultDisplay() != null) {
            windows.getDefaultDisplay().getRealMetrics(metrics);
        }
        int width = Math.max(1, metrics.widthPixels);
        int height = Math.max(1, metrics.heightPixels);
        int dpi = metrics.densityDpi > 0 ? metrics.densityDpi : DisplayMetrics.DENSITY_DEFAULT;

        thread = new HandlerThread("sage-screen-capture");
        thread.start();
        handler = new Handler(thread.getLooper());

        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(this::onImage, handler);
        virtualDisplay = projection.createVirtualDisplay(
                "sage-screen",
                width,
                height,
                dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.getSurface(),
                null,
                handler);

        projection.registerCallback(
                new MediaProjection.Callback() {
                    @Override
                    public void onStop() {
                        // The system ended the capture: the user revoked it from
                        // the status bar, or the display went away. Restarting
                        // without a fresh grant is not allowed, so stop cleanly.
                        stopSelf();
                    }
                },
                handler);

        running = true;
    }

    private void onImage(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null) return;
            long now = System.currentTimeMillis();
            if (now - lastFrameAt < intervalMs) return;
            lastFrameAt = now;

            Bitmap frame = toBitmap(image);
            if (frame == null) return;
            Bitmap scaled = scale(frame);
            byte[] jpeg = compress(scaled);
            if (scaled != frame) scaled.recycle();
            frame.recycle();
            if (jpeg == null) return;

            FrameListener target = listener;
            if (target != null) {
                target.onFrame(Base64.encodeToString(jpeg, Base64.NO_WRAP), scaled.getWidth(), scaled.getHeight());
            }
        } catch (Exception error) {
            // A frame that cannot be read is not worth tearing the capture down
            // for — the next one usually works.
        } finally {
            if (image != null) image.close();
        }
    }

    private static Bitmap toBitmap(Image image) {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int width = image.getWidth();
        int height = image.getHeight();
        int padding = rowStride - pixelStride * width;
        if (padding < 0) return null;

        Bitmap padded = Bitmap.createBitmap(width + padding / pixelStride, height, Bitmap.Config.ARGB_8888);
        buffer.rewind();
        padded.copyPixelsFromBuffer(buffer);
        if (padding == 0) return padded;
        Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, width, height);
        padded.recycle();
        return cropped;
    }

    private static Bitmap scale(Bitmap source) {
        int width = source.getWidth();
        if (width <= TARGET_WIDTH) return source;
        float ratio = TARGET_WIDTH / (float) width;
        return Bitmap.createScaledBitmap(
                source,
                TARGET_WIDTH,
                Math.max(1, Math.round(source.getHeight() * ratio)),
                true);
    }

    private static byte[] compress(Bitmap bitmap) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) return null;
        return out.toByteArray();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (reader != null) {
            reader.close();
            reader = null;
        }
        if (projection != null) {
            projection.stop();
            projection = null;
        }
        if (thread != null) {
            thread.quitSafely();
            thread = null;
        }
        handler = null;
        super.onDestroy();
    }
}
