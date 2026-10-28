package app.qianning.agent;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Places and cancels one alarm per scheduled task.
 *
 * Deliberately exact when the platform allows it and inexact when it does not:
 * a task that fires ten minutes late is a nuisance, an app that crashes because
 * it demanded a permission it never had is worse.
 */
final class Alarms {

    private Alarms() {}

    static void schedule(Context context, String id, long at, String title) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;

        PendingIntent intent = pending(context, id, at, title, PendingIntent.FLAG_UPDATE_CURRENT);
        if (intent == null) return;

        boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms();
        try {
            if (exact) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent);
            } else {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent);
            }
        } catch (SecurityException denied) {
            // Exact alarms were revoked between the check and the call.
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent);
        }

        AlarmStore.put(context, id, at, title);
    }

    static void cancel(Context context, String id) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) {
            PendingIntent intent = pending(context, id, 0, "", PendingIntent.FLAG_NO_CREATE);
            if (intent != null) {
                manager.cancel(intent);
                intent.cancel();
            }
        }
        AlarmStore.remove(context, id);
    }

    static void cancelAll(Context context) {
        for (AlarmStore.Entry entry : AlarmStore.all(context)) {
            cancel(context, entry.id);
        }
    }

    /** Re-arms everything from the stored mirror; used after a reboot. */
    static void restore(Context context) {
        long now = System.currentTimeMillis();
        for (AlarmStore.Entry entry : AlarmStore.all(context)) {
            if (entry.at <= now) {
                // The phone was off when it should have fired. Announce it once
                // now instead of silently dropping the period.
                ScheduleAlarmReceiver.announce(context, entry.id, entry.title);
                AlarmStore.remove(context, entry.id);
                continue;
            }
            schedule(context, entry.id, entry.at, entry.title);
        }
    }

    private static PendingIntent pending(Context context, String id, long at, String title, int flags) {
        Intent intent = new Intent(context, ScheduleAlarmReceiver.class)
                .setAction(ScheduleAlarmReceiver.ACTION_DUE)
                .putExtra(ScheduleAlarmReceiver.EXTRA_ID, id)
                .putExtra(ScheduleAlarmReceiver.EXTRA_TITLE, title)
                .putExtra(ScheduleAlarmReceiver.EXTRA_AT, at);
        int requestCode = id.hashCode();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return PendingIntent.getBroadcast(context, requestCode, intent, flags | PendingIntent.FLAG_IMMUTABLE);
        }
        return PendingIntent.getBroadcast(context, requestCode, intent, flags);
    }
}
