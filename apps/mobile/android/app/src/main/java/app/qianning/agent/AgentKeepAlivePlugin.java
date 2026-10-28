package app.qianning.agent;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The JavaScript door to {@link AgentForegroundService}.
 *
 * The contract is deliberately tiny — start, stop, running — because the phone
 * client only needs to say "a turn began" and "a turn ended". Everything about
 * notifications, channels and service types stays on this side of the bridge.
 */
@CapacitorPlugin(name = "AgentKeepAlive")
public class AgentKeepAlivePlugin extends Plugin {

    private static final int NOTIFICATION_REQUEST_CODE = 4712;

    @PluginMethod
    public void start(PluginCall call) {
        String text = call.getString("text", "");
        Context context = getContext();

        Intent intent = new Intent(context, AgentForegroundService.class)
                .setAction(AgentForegroundService.ACTION_START)
                .putExtra(AgentForegroundService.EXTRA_TEXT, text);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException error) {
            // Android rejects a foreground start when the app is already in the
            // background and the grace window has closed. The turn keeps
            // running while the app is foregrounded; report the refusal instead
            // of crashing the WebView.
            call.reject("foreground service refused: " + error.getMessage());
            return;
        }

        requestNotificationPermissionIfNeeded();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, AgentForegroundService.class)
                .setAction(AgentForegroundService.ACTION_STOP);
        context.startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", AgentForegroundService.RUNNING);
        call.resolve(result);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        if (getActivity() == null) {
            return;
        }
        boolean granted = getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        if (!granted) {
            getActivity().requestPermissions(
                    new String[] { Manifest.permission.POST_NOTIFICATIONS },
                    NOTIFICATION_REQUEST_CODE);
        }
    }
}
