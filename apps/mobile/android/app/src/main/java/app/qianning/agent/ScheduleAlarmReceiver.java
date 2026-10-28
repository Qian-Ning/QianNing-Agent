package app.qianning.agent;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * Fires when a scheduled task is due while the app is not running.
 *
 * This build cannot run an agent turn without the WebView, so the alarm does the
 * one honest thing it can: it tells the reader the task is waiting, and tapping
 * opens the app, where the ordinary runner picks it up immediately.
 */
public class ScheduleAlarmReceiver extends BroadcastReceiver {

    static final String ACTION_DUE = "app.qianning.agent.action.SCHEDULE_DUE";
    static final String EXTRA_ID = "id";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_AT = "at";

    private static final String CHANNEL_ID = "schedule_due";
    private static final int BASE_NOTIFICATION_ID = 5200;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DUE.equals(intent.getAction())) return;
        String id = intent.getStringExtra(EXTRA_ID);
        String title = intent.getStringExtra(EXTRA_TITLE);
        if (id == null) return;

        AlarmStore.remove(context, id);
        announce(context, id, title == null ? "" : title);
    }

    static void announce(Context context, String id, String title) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        createChannel(context, manager);

        Intent open = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("qn.scheduleId", id);
        PendingIntent tap = PendingIntent.getActivity(
                context,
                id.hashCode(),
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String name = title.isEmpty() ? context.getString(R.string.schedule_due_title) : title;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setContentTitle(context.getString(R.string.schedule_due_title))
                .setContentText(name)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(name + "\n" + context.getString(R.string.schedule_due_body)))
                .setAutoCancel(true)
                .setContentIntent(tap);

        manager.notify(BASE_NOTIFICATION_ID + (id.hashCode() & 0xff), builder.build());
    }

    private static void createChannel(Context context, NotificationManager manager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.schedule_due_channel),
                NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(context.getString(R.string.schedule_due_channel_desc));
        manager.createNotificationChannel(channel);
    }
}
