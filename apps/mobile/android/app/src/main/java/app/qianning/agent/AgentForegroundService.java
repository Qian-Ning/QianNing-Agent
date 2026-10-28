package app.qianning.agent;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Keeps the WebView's agent loop alive while a turn is running.
 *
 * Android freezes backgrounded apps, and a frozen WebView stops delivering the
 * streamed answer. A foreground service with an ongoing notification is the
 * platform's supported way to say "this process is doing work the user asked
 * for". It is started when a turn starts and stopped when the turn settles, so
 * the notification never outlives the work it describes.
 *
 * This class owns exactly one thing: the process-level announcement. The agent
 * itself keeps running in the WebView, unchanged.
 */
public class AgentForegroundService extends Service {

    public static final String ACTION_START = "app.qianning.agent.action.START";
    public static final String ACTION_STOP = "app.qianning.agent.action.STOP";
    public static final String EXTRA_TEXT = "text";

    /** Read by the bridge plugin; the platform no longer exposes a reliable check. */
    public static volatile boolean RUNNING = false;

    private static final String CHANNEL_ID = "agent_running";
    private static final int NOTIFICATION_ID = 4711;

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String text = intent == null ? null : intent.getStringExtra(EXTRA_TEXT);
        startInForeground(text);
        return START_NOT_STICKY;
    }

    private void startInForeground(@Nullable String text) {
        createChannel(this);
        String body = text == null || text.isEmpty()
                ? getString(R.string.agent_running_default)
                : text;

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
                this,
                0,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        RUNNING = true;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setContentTitle(getString(R.string.agent_running_title))
                .setContentText(body)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(tap);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    builder.build(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, builder.build(), 0);
        }
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.agent_running_channel),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(context.getString(R.string.agent_running_channel_desc));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        RUNNING = false;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
