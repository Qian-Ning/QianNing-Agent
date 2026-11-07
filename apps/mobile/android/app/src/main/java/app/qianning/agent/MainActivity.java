package app.qianning.agent;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import androidx.activity.result.ActivityResultLauncher;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

public class MainActivity extends BridgeActivity {

    /**
     * The launch window stays up until the page has something to show.
     *
     * A splash that disappears on a timer hands the reader an empty white screen
     * for however long the WebView still needs; one that waits forever hangs the
     * app on a failed load. This waits for `document.readyState === "complete"`
     * and gives up after three and a half seconds either way.
     */
    private volatile boolean firstFrameDrawn = false;

    /**
     * The camera is opened by zxing's own activity, which returns the decoded
     * text (or null when the user backs out). The launcher has to live here:
     * `registerForActivityResult` is only valid before `onStart`, and a plugin
     * is created after that.
     */
    private ActivityResultLauncher<ScanOptions> qrLauncher;
    private QrScanPlugin qrCaller;

    /** Starts a scan for `plugin`, which is resolved when the camera returns. */
    void beginQrScan(QrScanPlugin plugin) {
        if (qrLauncher == null) {
            plugin.deliver(null);
            return;
        }
        qrCaller = plugin;
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setPrompt("");
        options.setBeepEnabled(false);
        options.setOrientationLocked(false);
        qrLauncher.launch(options);
    }

    /**
     * The web layer decides what "back" means here: close a sheet, leave
     * settings, close the drawer, leave a conversation. Only when it answers
     * "not handled" does the activity go to the background — finishing it on the
     * first back press from the sessions list closed the whole app.
     */
    @Override
    public void onBackPressed() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            moveTaskToBack(true);
            return;
        }
        getBridge()
                .getWebView()
                .evaluateJavascript(
                        "(function(){try{return window.__qianningBack?String(window.__qianningBack()===true):'false';}catch(e){return 'false';}})()",
                        value -> {
                            boolean handled = "\"true\"".equals(value) || "true".equals(value);
                            if (!handled) {
                                runOnUiThread(() -> moveTaskToBack(true));
                            }
                        });
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        splash.setKeepOnScreenCondition(() -> !firstFrameDrawn);

        qrLauncher = registerForActivityResult(new ScanContract(), result -> {
            QrScanPlugin caller = qrCaller;
            qrCaller = null;
            if (caller != null) {
                caller.deliver(result.getContents());
            }
        });

        // Registered before the bridge starts so the WebView can call it on
        // its first render.
        registerPlugin(AgentKeepAlivePlugin.class);
        registerPlugin(ScheduleAlarmPlugin.class);
        registerPlugin(NoticePlugin.class);
        registerPlugin(PermissionsPlugin.class);
        registerPlugin(ShellPlugin.class);
        registerPlugin(BrowserPlugin.class);
        registerPlugin(FilesPlugin.class);
        registerPlugin(RemoteHostPlugin.class);
        registerPlugin(SshPlugin.class);
        registerPlugin(QrScanPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        watchForFirstFrame();
    }

    private void watchForFirstFrame() {
        Handler handler = new Handler(Looper.getMainLooper());
        long started = SystemClock.uptimeMillis();

        Runnable poll =
                new Runnable() {
                    @Override
                    public void run() {
                        if (firstFrameDrawn) {
                            return;
                        }
                        if (getBridge() == null || getBridge().getWebView() == null) {
                            firstFrameDrawn = true;
                            return;
                        }
                        if (SystemClock.uptimeMillis() - started > 3500) {
                            firstFrameDrawn = true;
                            return;
                        }
                        getBridge()
                                .getWebView()
                                .evaluateJavascript(
                                        "(function(){try{return String(document.readyState);}catch(e){return 'loading';}})()",
                                        value -> {
                                            if (value != null && value.contains("complete")) {
                                                // One frame of grace so the first paint
                                                // lands before the window is handed over.
                                                handler.postDelayed(() -> firstFrameDrawn = true, 120);
                                            }
                                        });
                        handler.postDelayed(this, 120);
                    }
                };

        handler.postDelayed(poll, 80);
    }
}
