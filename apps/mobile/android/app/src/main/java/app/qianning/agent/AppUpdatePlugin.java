package app.qianning.agent;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Finds the newest Android build and hands it to the system installer.
 *
 * The phone is sideloaded, so there is no store to update from. The release page
 * is the source of truth: this asks GitHub for the latest release, picks the
 * asset that ends in `-android.apk`, downloads it into the cache and starts the
 * package installer. Android shows its own confirmation — an app cannot install
 * silently, and the phone must also have allowed installs from this app.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private static final String RELEASES = "https://api.github.com/repos/Qian-Ning/QianNing-Agent/releases/latest";

    /** The newest published build, or the reason there is none. */
    @PluginMethod
    public void latest(PluginCall call) {
        new Thread(() -> {
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(RELEASES).openConnection();
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                connection.setRequestProperty("User-Agent", "QianNing-Agent");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                int status = connection.getResponseCode();
                if (status != 200) {
                    call.reject("release-lookup-failed:" + status);
                    return;
                }
                String body = readAll(connection.getInputStream());
                JSONObject release = new JSONObject(body);
                String tag = release.optString("tag_name", "");
                JSONArray assets = release.optJSONArray("assets");
                String url = null;
                long size = 0;
                if (assets != null) {
                    for (int index = 0; index < assets.length(); index += 1) {
                        JSONObject asset = assets.getJSONObject(index);
                        String name = asset.optString("name", "");
                        if (name.endsWith("-android.apk")) {
                            url = asset.optString("browser_download_url", null);
                            size = asset.optLong("size", 0);
                            break;
                        }
                    }
                }
                if (url == null) {
                    call.reject("no-apk-asset");
                    return;
                }
                JSObject result = new JSObject();
                result.put("tag", tag);
                result.put("version", tag.startsWith("v") ? tag.substring(1) : tag);
                result.put("url", url);
                result.put("size", size);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("release-lookup-failed:" + error.getMessage());
            }
        }).start();
    }

    /**
     * Fetches the build into the cache without touching the installer.
     *
     * A phone on a slow link should not make the user sit through a download
     * the moment they tap "install". Fetching ahead means the tap only has to
     * open the system installer.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("missing-url");
            return;
        }
        new Thread(() -> {
            try {
                File target = fetch(url);
                JSObject result = new JSObject();
                result.put("bytes", target.length());
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage());
            }
        }).start();
    }

    /** Is a download already sitting in the cache, and how big is it. */
    @PluginMethod
    public void cached(PluginCall call) {
        File target = cachedFile();
        long bytes = target != null && target.isFile() ? target.length() : 0;
        JSObject result = new JSObject();
        result.put("bytes", bytes);
        result.put("ready", bytes >= MIN_APK_BYTES);
        call.resolve(result);
    }

    /** Downloads that build and opens the installer. */
    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            // The screen that grants this is a system settings page; the page
            // can explain and the user returns and taps again.
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            settings.setData(Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("install-permission");
            return;
        }
        new Thread(() -> {
            try {
                File target = cachedFile();
                if (target == null || !target.isFile() || target.length() < MIN_APK_BYTES) {
                    if (url == null || url.isEmpty()) {
                        call.reject("missing-url");
                        return;
                    }
                    target = fetch(url);
                }
                Uri uri = FileProvider.getUriForFile(
                        getContext(), getContext().getPackageName() + ".fileprovider", target);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                JSObject result = new JSObject();
                result.put("bytes", target.length());
                call.resolve(result);
            } catch (Exception error) {
                call.reject("download-failed:" + error.getMessage());
            }
        }).start();
    }

    private static final long MIN_APK_BYTES = 1024L * 1024L;

    /** Where a fetched build waits. Null when the cache directory is unusable. */
    private File cachedFile() {
        File directory = new File(getContext().getCacheDir(), "updates");
        if (!directory.exists() && !directory.mkdirs()) return null;
        return new File(directory, "qianning-agent.apk");
    }

    /**
     * Downloads into a temporary name and only then renames it into place, so
     * an interrupted fetch can never be mistaken for a finished one.
     */
    private File fetch(String url) throws Exception {
        File target = cachedFile();
        if (target == null) throw new Exception("cache-unavailable");
        File partial = new File(target.getParentFile(), "qianning-agent.apk.part");
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestProperty("User-Agent", "QianNing-Agent");
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(60000);
        if (connection.getResponseCode() != 200) {
            throw new Exception("download-failed:" + connection.getResponseCode());
        }
        try (InputStream input = connection.getInputStream();
             FileOutputStream output = new FileOutputStream(partial)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) > 0) {
                output.write(buffer, 0, read);
            }
        }
        if (partial.length() < MIN_APK_BYTES) {
            partial.delete();
            throw new Exception("download-incomplete");
        }
        if (!partial.renameTo(target)) {
            partial.delete();
            throw new Exception("cache-unavailable");
        }
        return target;
    }

    private static String readAll(InputStream input) throws Exception {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = input.read(chunk)) > 0) {
            buffer.write(chunk, 0, read);
        }
        return buffer.toString("UTF-8");
    }
}
