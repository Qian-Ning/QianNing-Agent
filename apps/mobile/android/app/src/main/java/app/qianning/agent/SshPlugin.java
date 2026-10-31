package app.qianning.agent;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.UserInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * SSH to the machines the user owns.
 *
 * A phone has no ssh binary, so the connections page needs a real client in the
 * app. JSch is that client: password and key auth, a shell channel for the
 * terminal surface, and an exec channel for one-shot commands.
 *
 * Two rules this file enforces rather than documents:
 *
 *   - the host key is pinned. The first connection records the server's key
 *     fingerprint; every later one must match it, and a mismatch is refused
 *     with the two fingerprints so the page can say what changed.
 *   - credentials never leave the app's private storage. They are written to
 *     SharedPreferences by this plugin and are not returned to the renderer —
 *     the page asks for a profile, never for its password.
 */
@CapacitorPlugin(name = "QnSsh")
public class SshPlugin extends Plugin {

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int MAX_OUTPUT = 400_000;
    private static final String PREFS = "qn_ssh";

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Map<String, ChannelShell> shells = new ConcurrentHashMap<>();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String fingerprint(byte[] key) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(key);
            StringBuilder out = new StringBuilder(hash.length * 3);
            for (byte value : hash) {
                if (out.length() > 0) out.append(':');
                out.append(String.format("%02X", value));
            }
            return out.toString();
        } catch (Exception error) {
            return "";
        }
    }

    /** Records the key it saw and refuses a key that is not the pinned one. */
    private static final class PinnedKeys implements HostKeyRepository {
        private final String expected;
        String seen = "";

        PinnedKeys(String expected) {
            this.expected = expected;
        }

        @Override
        public int check(String host, byte[] key) {
            seen = fingerprint(key);
            if (expected == null || expected.isEmpty()) return OK;
            return expected.equalsIgnoreCase(seen) ? OK : CHANGED;
        }

        @Override public void add(HostKey hostkey, UserInfo ui) {}
        @Override public void remove(String host, String type) {}
        @Override public void remove(String host, String type, byte[] key) {}
        @Override public String getKnownHostsRepositoryID() { return "qn-ssh"; }
        @Override public HostKey[] getHostKey() { return new HostKey[0]; }
        @Override public HostKey[] getHostKey(String host, String type) { return new HostKey[0]; }
    }

    private JSONObject profileOf(String id) throws Exception {
        JSONArray all = new JSONArray(prefs().getString("profiles", "[]"));
        for (int index = 0; index < all.length(); index += 1) {
            JSONObject entry = all.getJSONObject(index);
            if (id.equals(entry.optString("id"))) return entry;
        }
        throw new IllegalStateException("that machine is no longer saved");
    }

    private void writeProfiles(JSONArray all) {
        prefs().edit().putString("profiles", all.toString()).apply();
    }

    private Session open(JSONObject profile) throws Exception {
        String host = profile.getString("host");
        int port = profile.optInt("port", 22);
        String user = profile.getString("user");
        String id = profile.getString("id");

        JSch jsch = new JSch();
        String key = prefs().getString("key." + id, "");
        String passphrase = prefs().getString("passphrase." + id, "");
        if (!key.isEmpty()) {
            byte[] pass = passphrase.isEmpty() ? null : passphrase.getBytes(StandardCharsets.UTF_8);
            jsch.addIdentity("qn-" + id, key.getBytes(StandardCharsets.UTF_8), null, pass);
        }

        Session session = jsch.getSession(user, host, port);
        String password = prefs().getString("password." + id, "");
        if (!password.isEmpty()) session.setPassword(password);
        session.setConfig("StrictHostKeyChecking", "yes");
        PinnedKeys keys = new PinnedKeys(profile.optString("fingerprint", ""));
        session.setHostKeyRepository(keys);
        session.setServerAliveInterval(30_000);
        // No socket read timeout here on purpose: it would apply to every read
        // after the handshake, and an idle terminal would be killed by it. The
        // connect call carries its own timeout instead.
        // JSch's own key exchange list, minus anything the server refuses.
        session.setConfig("PreferredAuthentications", "publickey,password,keyboard-interactive");
        try {
            session.connect(CONNECT_TIMEOUT_MS);
        } catch (Exception error) {
            if (!keys.seen.isEmpty() && !keys.seen.equalsIgnoreCase(profile.optString("fingerprint", ""))
                    && !profile.optString("fingerprint", "").isEmpty()) {
                throw new IllegalStateException("HOST_KEY_CHANGED:" + keys.seen);
            }
            throw error;
        }
        // First contact: remember the key so the next connection is pinned.
        if (profile.optString("fingerprint", "").isEmpty() && !keys.seen.isEmpty()) {
            try {
                JSONArray all = new JSONArray(prefs().getString("profiles", "[]"));
                for (int index = 0; index < all.length(); index += 1) {
                    JSONObject entry = all.getJSONObject(index);
                    if (id.equals(entry.optString("id"))) entry.put("fingerprint", keys.seen);
                }
                writeProfiles(all);
            } catch (Exception ignored) {
                // Pinning still applies for this session; the next one re-records.
            }
        }
        return session;
    }

    private static String readAll(InputStream stream) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = stream.read(buffer)) != -1) {
            out.write(buffer, 0, read);
            if (out.size() > MAX_OUTPUT) break;
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static JSObject profileView(JSONObject entry) {
        JSObject view = new JSObject();
        view.put("id", entry.optString("id"));
        view.put("name", entry.optString("name"));
        view.put("host", entry.optString("host"));
        view.put("port", entry.optInt("port", 22));
        view.put("user", entry.optString("user"));
        view.put("enabled", entry.optBoolean("enabled", true));
        view.put("auth", entry.optString("auth", "password"));
        view.put("fingerprint", entry.optString("fingerprint", ""));
        view.put("hasSecret", entry.optBoolean("hasSecret", false));
        return view;
    }

    @PluginMethod
    public void profiles(PluginCall call) {
        pool.execute(() -> {
            try {
                JSONArray all = new JSONArray(prefs().getString("profiles", "[]"));
                JSArray out = new JSArray();
                for (int index = 0; index < all.length(); index += 1) {
                    out.put(profileView(all.getJSONObject(index)));
                }
                JSObject result = new JSObject();
                result.put("profiles", out);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    @PluginMethod
    public void saveProfile(PluginCall call) {
        String name = call.getString("name", "").trim();
        String host = call.getString("host", "").trim();
        String user = call.getString("user", "").trim();
        int port = call.getInt("port", 22);
        String auth = call.getString("auth", "password");
        String password = call.getString("password", null);
        String privateKey = call.getString("privateKey", null);
        String passphrase = call.getString("passphrase", null);
        String id = call.getString("id", null);
        boolean enabled = call.getBoolean("enabled", true);
        if (host.isEmpty() || user.isEmpty()) {
            call.reject("填写地址和用户名");
            return;
        }
        pool.execute(() -> {
            try {
                JSONArray all = new JSONArray(prefs().getString("profiles", "[]"));
                JSONObject entry = null;
                if (id != null && !id.isEmpty()) {
                    for (int index = 0; index < all.length(); index += 1) {
                        JSONObject candidate = all.getJSONObject(index);
                        if (id.equals(candidate.optString("id"))) entry = candidate;
                    }
                }
                boolean fresh = entry == null;
                if (fresh) {
                    entry = new JSONObject();
                    entry.put("id", "ssh_" + UUID.randomUUID().toString().substring(0, 8));
                    all.put(entry);
                }
                entry.put("name", name.isEmpty() ? host : name);
                entry.put("host", host);
                entry.put("port", port <= 0 ? 22 : port);
                entry.put("user", user);
                entry.put("auth", auth);
                entry.put("enabled", enabled);
                String profileId = entry.getString("id");
                boolean hasSecret = entry.optBoolean("hasSecret", false);
                SharedPreferences.Editor editor = prefs().edit();
                if (password != null && !password.isEmpty()) {
                    editor.putString("password." + profileId, password);
                    editor.remove("key." + profileId);
                    hasSecret = true;
                }
                if (privateKey != null && !privateKey.trim().isEmpty()) {
                    editor.putString("key." + profileId, privateKey.trim() + "\n");
                    if (passphrase != null) editor.putString("passphrase." + profileId, passphrase);
                    editor.remove("password." + profileId);
                    hasSecret = true;
                }
                editor.apply();
                entry.put("hasSecret", hasSecret);
                writeProfiles(all);
                call.resolve(profileView(entry));
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    @PluginMethod
    public void deleteProfile(PluginCall call) {
        String id = call.getString("id", "");
        pool.execute(() -> {
            try {
                Session live = sessions.remove(id);
                if (live != null && live.isConnected()) live.disconnect();
                shells.remove(id);
                JSONArray all = new JSONArray(prefs().getString("profiles", "[]"));
                JSONArray kept = new JSONArray();
                for (int index = 0; index < all.length(); index += 1) {
                    JSONObject entry = all.getJSONObject(index);
                    if (!id.equals(entry.optString("id"))) kept.put(entry);
                }
                writeProfiles(kept);
                prefs().edit()
                        .remove("password." + id)
                        .remove("key." + id)
                        .remove("passphrase." + id)
                        .apply();
                JSObject result = new JSObject();
                result.put("ok", true);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    /**
     * Dial, read the banner, hang up. This is the button that answers "is this
     * machine reachable and is it still the machine I trusted".
     */
    @PluginMethod
    public void probe(PluginCall call) {
        String id = call.getString("id", "");
        pool.execute(() -> {
            try {
                JSONObject profile = profileOf(id);
                Session session = open(profile);
                String banner = session.getServerVersion();
                String print = profileOf(id).optString("fingerprint", "");
                session.disconnect();
                JSObject result = new JSObject();
                result.put("ok", true);
                result.put("banner", banner == null ? "" : banner);
                result.put("fingerprint", print);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String id = call.getString("id", "");
        pool.execute(() -> {
            try {
                JSONObject profile = profileOf(id);
                Session session = open(profile);
                sessions.put(id, session);
                JSObject result = new JSObject();
                result.put("sessionId", id);
                result.put("fingerprint", profileOf(id).optString("fingerprint", ""));
                call.resolve(result);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String id = call.getString("sessionId", call.getString("id", ""));
        pool.execute(() -> {
            ChannelShell shell = shells.remove(id);
            if (shell != null && shell.isConnected()) shell.disconnect();
            Session session = sessions.remove(id);
            if (session != null && session.isConnected()) session.disconnect();
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        });
    }

    /** One command, one answer — the shape a tool call wants. */
    @PluginMethod
    public void exec(PluginCall call) {
        String id = call.getString("sessionId", call.getString("id", ""));
        String command = call.getString("command", "");
        if (command == null || command.trim().isEmpty()) {
            call.reject("no command");
            return;
        }
        pool.execute(() -> {
            try {
                Session session = sessions.get(id);
                if (session == null || !session.isConnected()) {
                    session = open(profileOf(id));
                    sessions.put(id, session);
                }
                ChannelExec channel = (ChannelExec) session.openChannel("exec");
                channel.setCommand(command);
                InputStream streams = channel.getInputStream();
                InputStream errors = channel.getErrStream();
                channel.connect(CONNECT_TIMEOUT_MS);
                String out = readAll(streams);
                String err = errors == null ? "" : readAll(errors);
                // The exit status arrives with the channel close, a beat after
                // the last byte of output.
                long waitUntil = System.currentTimeMillis() + 3_000;
                while (channel.getExitStatus() == -1 && System.currentTimeMillis() < waitUntil) {
                    Thread.sleep(30);
                }
                int status = channel.getExitStatus();
                channel.disconnect();
                JSObject result = new JSObject();
                result.put("output", out);
                result.put("error", err);
                result.put("exitStatus", status);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    /**
     * One command inside a persistent login shell, so `cd` and exported
     * variables survive between calls — the same contract the local terminal
     * has. The sentinel carries the exit code and the working directory back.
     */
    @PluginMethod
    public void shell(PluginCall call) {
        String id = call.getString("sessionId", call.getString("id", ""));
        String command = call.getString("command", "");
        int timeoutMs = Math.max(1_000, Math.min(300_000, call.getInt("timeoutMs", 20_000)));
        if (command == null || command.trim().isEmpty()) {
            call.reject("no command");
            return;
        }
        pool.execute(() -> {
            try {
                Session session = sessions.get(id);
                if (session == null || !session.isConnected()) {
                    session = open(profileOf(id));
                    sessions.put(id, session);
                }
                ChannelShell channel = shells.get(id);
                if (channel == null || !channel.isConnected()) {
                    channel = (ChannelShell) session.openChannel("shell");
                    channel.setPty(true);
                    channel.connect(CONNECT_TIMEOUT_MS);
                    shells.put(id, channel);
                }
                OutputStream stdin = channel.getOutputStream();
                InputStream stdout = channel.getInputStream();
                String token = "__QN_" + Long.toHexString(System.nanoTime()) + "__";
                String wrapped = command + "\necho " + token + "$?|$PWD\n";
                stdin.write(wrapped.getBytes(StandardCharsets.UTF_8));
                stdin.flush();

                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[4096];
                long deadline = System.currentTimeMillis() + timeoutMs;
                while (System.currentTimeMillis() < deadline) {
                    if (stdout.available() > 0) {
                        int read = stdout.read(chunk);
                        if (read > 0) buffer.write(chunk, 0, read);
                        String text = buffer.toString("UTF-8");
                        int at = text.indexOf(token);
                        if (at >= 0 && text.indexOf('\n', at) >= 0) break;
                    } else {
                        Thread.sleep(40);
                    }
                    if (buffer.size() > MAX_OUTPUT) break;
                }
                String raw = buffer.toString("UTF-8");
                String output = raw;
                int exitCode = 0;
                String cwd = "";
                int at = raw.indexOf(token);
                if (at >= 0) {
                    int end = raw.indexOf('\n', at);
                    String tail = raw.substring(at + token.length(), end < 0 ? raw.length() : end);
                    String[] parts = tail.split("\\|", 2);
                    try {
                        exitCode = Integer.parseInt(parts[0].trim());
                    } catch (Exception ignored) {
                        exitCode = 0;
                    }
                    cwd = parts.length > 1 ? parts[1].trim() : "";
                    output = raw.substring(0, at);
                }
                if (!cwd.isEmpty()) {
                    // The prompt line the shell echoes mixes with real output;
                    // keep everything before the sentinel and trim the run of
                    // prompt noise that has no content of its own.
                    output = output.replaceAll("\\n+$", "");
                }
                JSObject result = new JSObject();
                result.put("output", output);
                result.put("exitStatus", exitCode);
                result.put("cwd", cwd);
                result.put("timedOut", raw.indexOf(token) < 0);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }
}
