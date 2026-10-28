package app.qianning.agent;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Posts the notification centre's entries as system notifications.
 *
 * The centre is a log inside the app; a glanceable notification is what makes
 * it useful when the app is not on screen. The contract stays small: request
 * the runtime permission once, post one entry, drop one entry when it is read.
 */
@CapacitorPlugin(name = "AgentNotice")
public class NoticePlugin extends Plugin {

    static final String CHANNEL_ID = "agent_notices";
    private static final int PERMISSION_REQUEST_CODE = 4713;

    @PluginMethod
    public void requestPermission(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        Context context = getContext();
        boolean granted = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        if (!granted && getActivity() != null) {
            getActivity().requestPermissions(
                    new String[] { Manifest.permission.POST_NOTIFICATIONS },
                    PERMISSION_REQUEST_CODE);
        }
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        String title = call.getString("title", "");
        String body = call.getString("body", "");
        String id = call.getString("id", "notice");
        if (title.isEmpty()) {
            call.reject("a notice needs a title");
            return;
        }
        if (!canPost()) {
            // No permission: the entry still lives in the in-app centre, so this
            // is reported rather than treated as a failure.
            JSObject result = new JSObject();
            result.put("posted", false);
            call.resolve(result);
            return;
        }

        Context context = getContext();
        ensureChannel(context);

        Intent open = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        String sessionId = call.getString("sessionId", "");
        if (!sessionId.isEmpty()) {
            open.putExtra("sessionId", sessionId);
        }
        PendingIntent content = PendingIntent.getActivity(
                context,
                id.hashCode(),
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(content)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(id.hashCode(), builder.build());
        }

        JSObject result = new JSObject();
        result.put("posted", true);
        call.resolve(result);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id", "");
        Context context = getContext();
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null && !id.isEmpty()) {
            manager.cancel(id.hashCode());
        }
        call.resolve();
    }

    private boolean canPost() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        return getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notice_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(context.getString(R.string.notice_channel_description));
        manager.createNotificationChannel(channel);
    }
}
