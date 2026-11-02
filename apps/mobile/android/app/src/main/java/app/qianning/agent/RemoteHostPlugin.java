package app.qianning.agent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import java.security.KeyStore;
import java.util.Collections;

/**
 * HTTPS to a paired computer, pinned to that computer's own certificate.
 *
 * The desktop's remote listener mints a self-signed certificate and serves it at
 * `/cert` before any credential exists. A phone cannot trust an unknown CA, and
 * trusting every certificate would defeat the point, so pairing is two steps:
 * fetch that one certificate (the only request allowed to skip verification),
 * then from then on trust exactly that certificate and nothing else.
 *
 * Everything here stays off the UI thread; the plugin answers on the bridge.
 */
@CapacitorPlugin(name = "QnRemote")
public class RemoteHostPlugin extends Plugin {

    /** Generous enough for a session list, small enough to never stall the bridge. */
    private static final int MAX_BODY = 8 * 1024 * 1024;
    private static final int TIMEOUT_MS = 15_000;

    private final ExecutorService pool = Executors.newCachedThreadPool();

    /** SHA-256 of the DER certificate, uppercase hex with colons, as the UI shows it. */
    private static String fingerprint(X509Certificate cert) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(cert.getEncoded());
        StringBuilder out = new StringBuilder(hash.length * 3);
        for (byte value : hash) {
            if (out.length() > 0) out.append(':');
            out.append(String.format("%02X", value));
        }
        return out.toString();
    }

    private static SSLSocketFactory pinnedFactory(String pem) throws Exception {
        CertificateFactory factory = CertificateFactory.getInstance("X.509");
        X509Certificate cert = (X509Certificate) factory.generateCertificate(
                new java.io.ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII)));
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
        store.load(null, null);
        store.setCertificateEntry("host", cert);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(store);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, tmf.getTrustManagers(), new SecureRandom());
        return context.getSocketFactory();
    }

    private static SSLSocketFactory trustingFactory() throws Exception {
        TrustManager[] trustAll = new TrustManager[]{
                new X509TrustManager() {
                    @Override public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                    @Override public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                    @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trustAll, new SecureRandom());
        return context.getSocketFactory();
    }

    private static String readBody(InputStream stream) throws Exception {
        if (stream == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = stream.read(buffer)) != -1) {
            out.write(buffer, 0, read);
            if (out.size() > MAX_BODY) break;
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String join(String base, String path) {
        String root = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        return path.startsWith("/") ? root + path : root + "/" + path;
    }

    /**
     * Fetch the listener's certificate over a connection that verifies nothing,
     * and hand back both the PEM to pin and the fingerprint to show.
     */
    @PluginMethod
    public void fetchCertificate(PluginCall call) {
        String base = call.getString("url", "");
        pool.execute(() -> {
            try {
                HttpsURLConnection connection = (HttpsURLConnection) new URL(join(base, "/cert")).openConnection();
                connection.setSSLSocketFactory(trustingFactory());
                connection.setHostnameVerifier(new HostnameVerifier() {
                    @Override public boolean verify(String host, SSLSession session) { return true; }
                });
                connection.setConnectTimeout(TIMEOUT_MS);
                connection.setReadTimeout(TIMEOUT_MS);
                connection.setRequestMethod("GET");
                int status = connection.getResponseCode();
                String body = status >= 400
                        ? readBody(connection.getErrorStream())
                        : readBody(connection.getInputStream());
                if (status != 200 || !body.contains("BEGIN CERTIFICATE")) {
                    call.reject("that address did not return a certificate (" + status + ")");
                    return;
                }
                CertificateFactory factory = CertificateFactory.getInstance("X.509");
                X509Certificate cert = (X509Certificate) factory.generateCertificate(
                        new java.io.ByteArrayInputStream(body.getBytes(StandardCharsets.US_ASCII)));
                JSObject result = new JSObject();
                result.put("pem", body.trim());
                result.put("fingerprint", fingerprint(cert));
                result.put("subject", cert.getSubjectX500Principal().getName());
                result.put("notAfter", cert.getNotAfter().getTime());
                call.resolve(result);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    /** One authenticated RACP-HTTP call, accepting only the pinned certificate. */
    @PluginMethod
    public void request(PluginCall call) {
        String base = call.getString("url", "");
        String method = call.getString("method", "GET");
        String path = call.getString("path", "/");
        String token = call.getString("token", "");
        String pem = call.getString("pem", "");
        String body = call.getString("body", null);
        if (base.isEmpty() || pem.isEmpty()) {
            call.reject("a paired computer needs an address and its certificate");
            return;
        }
        pool.execute(() -> {
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(join(base, path)).openConnection();
                if (connection instanceof HttpsURLConnection) {
                    ((HttpsURLConnection) connection).setSSLSocketFactory(pinnedFactory(pem));
                    ((HttpsURLConnection) connection).setHostnameVerifier(new HostnameVerifier() {
                        @Override public boolean verify(String host, SSLSession session) { return true; }
                    });
                }
                connection.setConnectTimeout(TIMEOUT_MS);
                connection.setReadTimeout(TIMEOUT_MS);
                connection.setRequestMethod(method);
                connection.setRequestProperty("Accept", "application/json");
                if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
                if (body != null) {
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json");
                    try (OutputStream out = connection.getOutputStream()) {
                        out.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                }
                int status = connection.getResponseCode();
                String text = status >= 400
                        ? readBody(connection.getErrorStream())
                        : readBody(connection.getInputStream());
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", text);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }
}
