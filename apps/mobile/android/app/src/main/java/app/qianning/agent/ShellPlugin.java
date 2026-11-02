package app.qianning.agent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * A shell that belongs to this app — and stays open.
 *
 * The first version spawned `/system/bin/sh` per command, which forced every
 * call to be self-contained: no `cd` that survived, no exported variable, no
 * state at all, and a process spawn on every command. This one keeps a single
 * shell alive and delimits each command with a sentinel line that carries the
 * exit code and the working directory back, so the session behaves like a
 * session.
 *
 * What stays bounded, on purpose:
 * - every command has its own deadline (default 60s, up to 5 minutes per call);
 *   a command that blows it kills the shell and the next call starts clean
 * - output is capped head-and-tail, because the useful part of a failure is
 *   almost always the end
 * - the child inherits the app's uid, so it reaches nothing the app cannot
 */
@CapacitorPlugin(name = "QnShell")
public class ShellPlugin extends Plugin {

    private static final long DEFAULT_TIMEOUT_MS = 60_000L;
    private static final long MIN_TIMEOUT_MS = 1_000L;
    private static final long MAX_TIMEOUT_MS = 300_000L;
    private static final int MAX_OUTPUT_CHARS = 200_000;
    private static final int KEEP_TAIL_CHARS = 120_000;
    private static final int MAX_COMMAND_CHARS = 32_000;

    private final Object lock = new Object();
    private final BlockingQueue<String> lines = new LinkedBlockingQueue<>();

    private Process process;
    private BufferedWriter input;
    private String mark;
    private String cwd;

    @PluginMethod
    public void exec(PluginCall call) {
        final String command = call.getString("command", "");
        if (command == null || command.trim().isEmpty()) {
            call.reject("empty command");
            return;
        }
        if (command.length() > MAX_COMMAND_CHARS) {
            call.reject("command is too long");
            return;
        }
        final long timeoutMs = clamp(call.getLong("timeoutMs", DEFAULT_TIMEOUT_MS));

        new Thread(() -> call.resolve(run(command, timeoutMs)), "qn-shell").start();
    }

    private JSObject run(String command, long timeoutMs) {
        long started = System.currentTimeMillis();
        StringBuilder head = new StringBuilder();
        Deque<String> tail = new ArrayDeque<>();
        int tailChars = 0;
        boolean truncated = false;
        int code = -1;
        String ended = "";

        synchronized (lock) {
            try {
                ensure();
            } catch (IOException error) {
                return error(error, started);
            }

            lines.clear();
            mark = nextMark();
            try {
                input.write(command);
                if (!command.endsWith("\n")) input.write("\n");
                // The sentinel carries both facts the caller needs and nothing else.
                input.write("echo " + mark + "$?|$PWD\n");
                input.flush();
            } catch (IOException error) {
                restart();
                return error(error, started);
            }

            long deadline = System.currentTimeMillis() + timeoutMs;
            while (true) {
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) {
                    truncated = true;
                    restart();
                    break;
                }
                String line;
                try {
                    line = lines.poll(Math.min(remaining, 250L), TimeUnit.MILLISECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    restart();
                    break;
                }
                if (line == null) {
                    continue;
                }
                if (line.startsWith(mark)) {
                    ended = line.substring(mark.length());
                    break;
                }
                // Cap by keeping the first block and the most recent lines: the
                // start says what ran, the end says why it failed.
                if (head.length() < MAX_OUTPUT_CHARS - KEEP_TAIL_CHARS) {
                    head.append(line).append('\n');
                } else {
                    truncated = true;
                    tail.addLast(line);
                    tailChars += line.length() + 1;
                    while (tailChars > KEEP_TAIL_CHARS && !tail.isEmpty()) {
                        String dropped = tail.removeFirst();
                        tailChars -= dropped.length() + 1;
                    }
                }
            }
        }

        String output = head.toString();
        if (!tail.isEmpty()) {
            output = output + "…(output trimmed)…\n" + String.join("\n", tail) + "\n";
        }

        int separator = ended.lastIndexOf('|');
        if (separator > 0) {
            try {
                code = Integer.parseInt(ended.substring(0, separator).trim());
            } catch (NumberFormatException ignored) {
                code = -1;
            }
            String where = ended.substring(separator + 1).trim();
            if (!where.isEmpty()) cwd = where;
        }

        JSObject result = new JSObject();
        result.put("output", output);
        result.put("code", code);
        result.put("cwd", cwd == null ? getContext().getFilesDir().getAbsolutePath() : cwd);
        result.put("truncated", truncated);
        result.put("durationMs", System.currentTimeMillis() - started);
        result.put("persistent", true);
        return result;
    }

    /**
     * Starts the shell if it is not running. The session outlives a turn, which
     * is the point: `cd`, `export` and any variable the agent sets stay set
     * until the app dies or a command times out.
     */
    private void ensure() throws IOException {
        if (process != null && process.isAlive()) return;

        File home = getContext().getFilesDir();
        File bin = new File(home, "bin");
        if (!bin.isDirectory()) {
            //noinspection ResultOfMethodCallIgnored
            bin.mkdirs();
        }

        ProcessBuilder builder = new ProcessBuilder("/system/bin/sh");
        builder.directory(home);
        builder.redirectErrorStream(true);
        builder.environment().put("HOME", home.getAbsolutePath());
        builder.environment().put("TMPDIR", getContext().getCacheDir().getAbsolutePath());
        builder.environment().put("PATH", bin.getAbsolutePath()
                + ":/sbin:/system/sbin:/system/bin:/system/xbin:/vendor/bin");
        builder.environment().put("PWD", home.getAbsolutePath());
        builder.environment().put("TERM", "dumb");
        builder.environment().put("QN_APP", getContext().getPackageName());

        process = builder.start();
        input = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        cwd = home.getAbsolutePath();

        BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        Thread pump = new Thread(() -> {
            try {
                String line;
                while ((line = reader.readLine()) != null) {
                    lines.offer(line);
                }
            } catch (IOException ignored) {
                // The shell was killed; the queue simply stops filling.
            }
        }, "qn-shell-reader");
        pump.setDaemon(true);
        pump.start();
    }

    private void restart() {
        if (process != null) {
            process.destroy();
            process = null;
        }
        input = null;
        cwd = null;
        lines.clear();
    }

    private static String nextMark() {
        return "__QN_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10) + "__";
    }

    private JSObject error(Exception error, long started) {
        JSObject result = new JSObject();
        result.put("output", String.valueOf(error.getMessage()));
        result.put("code", -1);
        result.put("cwd", getContext().getFilesDir().getAbsolutePath());
        result.put("error", String.valueOf(error.getMessage()));
        result.put("durationMs", System.currentTimeMillis() - started);
        return result;
    }

    private static long clamp(long value) {
        return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, value));
    }

    /**
     * Where the shell is and what it is, so the terminal can print a prompt and
     * the agent can orient itself without running `pwd` and `echo $PATH`.
     */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject result = new JSObject();
        result.put("cwd", cwd == null ? getContext().getFilesDir().getAbsolutePath() : cwd);
        result.put("home", getContext().getFilesDir().getAbsolutePath());
        result.put("bin", new File(getContext().getFilesDir(), "bin").getAbsolutePath());
        result.put("user", "u0_a" + android.os.Process.myUid());
        result.put("defaultTimeoutMs", DEFAULT_TIMEOUT_MS);
        result.put("maxTimeoutMs", MAX_TIMEOUT_MS);
        result.put("maxOutputChars", MAX_OUTPUT_CHARS);
        call.resolve(result);
    }

    /** Ends the session; the next call starts clean in the app's storage. */
    @PluginMethod
    public void reset(PluginCall call) {
        synchronized (lock) {
            restart();
        }
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }
}
