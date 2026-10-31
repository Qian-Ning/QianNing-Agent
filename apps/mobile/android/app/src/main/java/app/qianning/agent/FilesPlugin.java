package app.qianning.agent;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.file.Files;

/**
 * The system file picker, bridged to the composer's attach button.
 *
 * A phone has no paths to hand out: what the user picks is a content URI that
 * lives as long as its grant. So each pick is copied into the app's own cache
 * before the plugin answers — from then on the file is a normal file inside the
 * sandbox, readable by the shell plugin and by the agent's file tools.
 */
@CapacitorPlugin(name = "QnFiles")
public class FilesPlugin extends Plugin {

    /** Big enough for a log or a document, small enough to survive a copy. */
    private static final long MAX_BYTES = 8L * 1024L * 1024L;
    private static final int MAX_FILES = 10;

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "handlePick");
    }

    @ActivityCallback
    private void handlePick(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject canceled = new JSObject();
            canceled.put("files", new JSArray());
            canceled.put("canceled", true);
            call.resolve(canceled);
            return;
        }

        Intent data = result.getData();
        JSArray out = new JSArray();
        try {
            File dir = new File(getContext().getCacheDir(), "picked");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("cannot create the pick cache");
                return;
            }

            if (data.getClipData() != null) {
                int count = Math.min(data.getClipData().getItemCount(), MAX_FILES);
                for (int i = 0; i < count; i += 1) {
                    copy(data.getClipData().getItemAt(i).getUri(), dir, out);
                }
            } else if (data.getData() != null) {
                copy(data.getData(), dir, out);
            }

            JSObject payload = new JSObject();
            payload.put("files", out);
            call.resolve(payload);
        } catch (Exception error) {
            call.reject("pick failed: " + error.getMessage());
        }
    }

    private void copy(Uri uri, File dir, JSArray out) throws Exception {
        String name = displayName(uri);
        if (name == null || name.trim().isEmpty()) name = "file";
        String safe = name.replaceAll("[\\\\/:*?\"<>|]+", "-");

        // The same name twice in one pick must not overwrite the first copy.
        File target = new File(dir, safe);
        int suffix = 2;
        while (target.exists()) {
            target = new File(dir, suffix + "-" + safe);
            suffix += 1;
        }

        long written = 0;
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             FileOutputStream sink = new FileOutputStream(target)) {
            if (in == null) return;
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) {
                written += read;
                if (written > MAX_BYTES) {
                    sink.close();
                    // Too large to be useful in a chat turn; keep the pick honest.
                    target.delete();
                    return;
                }
                sink.write(buffer, 0, read);
            }
        }

        JSObject file = new JSObject();
        file.put("name", target.getName());
        file.put("path", target.getAbsolutePath());
        file.put("size", written);
        file.put("mimeType", getContext().getContentResolver().getType(uri));
        out.put(file);
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver()
                .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                return cursor.getString(0);
            }
        } catch (Exception ignored) {
            // Fall through to the last path segment.
        }
        String last = uri.getLastPathSegment();
        return last == null ? null : last;
    }

    /**
     * Save a data URL the app produced — a generated render — under the app's
     * own files directory and answer with the absolute path.
     *
     * The workbench receives images as base64 from the provider; without this
     * the only other write path would be a shell heredoc, which mangles large
     * binary payloads.
     */
    @PluginMethod
    public void writeBase64(PluginCall call) {
        String name = call.getString("name", "");
        String data = call.getString("data", "");
        String folder = call.getString("folder", "media");
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("..")) {
            call.reject("a file name is required");
            return;
        }
        if (data == null || data.isEmpty()) {
            call.reject("nothing to write");
            return;
        }
        try {
            String base64 = data.contains(",") ? data.substring(data.indexOf(',') + 1) : data;
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (bytes.length > MAX_BYTES * 8) {
                call.reject("that image is too large to keep");
                return;
            }
            File dir = new File(getContext().getFilesDir(), folder);
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("could not create " + folder);
                return;
            }
            File target = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(target)) {
                out.write(bytes);
            }
            JSObject result = new JSObject();
            result.put("path", target.getAbsolutePath());
            result.put("size", bytes.length);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("write failed: " + error.getMessage());
        }
    }

    /** The bytes of a picked file, as a data URL — what the composer previews. */
    @PluginMethod
    public void readDataUrl(PluginCall call) {
        String path = call.getString("path", "");
        String mime = call.getString("mimeType", "");
        File file = path == null ? null : new File(path);
        if (file == null || !file.exists() || !file.isFile()) {
            JSObject missing = new JSObject();
            missing.put("kind", "missing");
            call.resolve(missing);
            return;
        }
        if (file.length() > MAX_BYTES) {
            JSObject large = new JSObject();
            large.put("kind", "tooLarge");
            large.put("size", file.length());
            call.resolve(large);
            return;
        }
        try {
            byte[] bytes = Files.readAllBytes(file.toPath());
            String type = (mime == null || mime.isEmpty())
                    ? "application/octet-stream" : mime;
            JSObject out = new JSObject();
            out.put("kind", "image");
            out.put("size", bytes.length);
            out.put("dataUrl", "data:" + type + ";base64,"
                    + Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(out);
        } catch (Exception error) {
            call.reject("read failed: " + error.getMessage());
        }
    }
}
