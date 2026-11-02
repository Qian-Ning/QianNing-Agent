package app.qianning.agent;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * The in-app browser.
 *
 * A page inside the app, not a hand-off to Chrome: the conversation stays where
 * it was, back returns to it in one gesture, and the address bar is the only
 * chrome. Built in code because it is one bar and one WebView — an XML layout
 * would be more files for less clarity.
 */
public class BrowserActivity extends Activity {

    /**
     * The last page, as the plugin reports it. A WebView outlives no process,
     * so a static snapshot is enough: the window that owns it is the only
     * reader, and the agent asks for it right after the page settles.
     */
    private static volatile String lastUrl = "";
    private static volatile String lastTitle = "";
    private static volatile String lastText = "";
    private static java.lang.ref.WeakReference<BrowserActivity> openWindow = new java.lang.ref.WeakReference<>(null);

    static String[] snapshot() {
        return new String[] { lastUrl, lastTitle, lastText };
    }

    static boolean isOpen() {
        BrowserActivity window = openWindow.get();
        return window != null && !window.isFinishing();
    }

    static void closeWindow() {
        BrowserActivity window = openWindow.get();
        if (window != null) {
            window.runOnUiThread(window::finish);
        }
    }

    private WebView web;
    private EditText address;
    private ProgressBar progress;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        openWindow = new java.lang.ref.WeakReference<>(this);

        float density = getResources().getDisplayMetrics().density;
        int pad = Math.round(8 * density);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(pad, pad, pad, pad);
        bar.setBackgroundColor(Color.parseColor("#F4F4F5"));

        Button back = new Button(this);
        back.setText("‹");
        back.setTextSize(20);
        back.setOnClickListener(v -> goBack());
        bar.addView(back, new LinearLayout.LayoutParams(
                Math.round(40 * density), ViewGroup.LayoutParams.WRAP_CONTENT));

        address = new EditText(this);
        address.setSingleLine(true);
        address.setTextSize(13);
        address.setHint("https://");
        address.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_GO);
        address.setOnEditorActionListener((v, actionId, event) -> {
            open(address.getText().toString());
            return true;
        });
        bar.addView(address, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button close = new Button(this);
        close.setText("✕");
        close.setOnClickListener(v -> finish());
        bar.addView(close, new LinearLayout.LayoutParams(
                Math.round(40 * density), ViewGroup.LayoutParams.WRAP_CONTENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Everything stays inside this window; the external app chooser is
                // never opened from a page the user did not ask to leave.
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                address.setText(url);
                progress.setVisibility(View.GONE);
                lastUrl = url;
                lastTitle = view.getTitle() == null ? "" : view.getTitle();
                // Read the rendered text, not the source: the point of a browser
                // is what the page actually shows after its scripts ran.
                view.evaluateJavascript(
                        "(function(){try{return document.body?document.body.innerText:'';}catch(e){return '';}})()",
                        value -> {
                            String text = unquote(value);
                            lastText = text.length() > 200_000 ? text.substring(0, 200_000) : text;
                        });
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
                progress.setProgress(newProgress);
            }
        });

        root.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(progress, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.round(2 * density)));
        root.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        String url = getIntent().getStringExtra("url");
        if (url != null && !url.trim().isEmpty()) {
            open(url);
        }
    }

    private void open(String raw) {
        String url = normalize(raw);
        if (url.isEmpty()) {
            return;
        }
        address.setText(url);
        web.loadUrl(url);
    }

    /** The WebView returns a JS string as a JSON literal; decode it properly. */
    private static String unquote(String value) {
        if (value == null || value.equals("null")) {
            return "";
        }
        if (!value.startsWith("\"")) {
            return value;
        }
        try {
            return new org.json.JSONArray("[" + value + "]").getString(0);
        } catch (Exception ignored) {
            return value.length() >= 2 ? value.substring(1, value.length() - 1) : "";
        }
    }

    private static String normalize(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return "";
        }
        if (value.startsWith("http://") || value.startsWith("https://")) {
            return value;
        }
        if (value.contains(" ") || !value.contains(".")) {
            return "https://www.bing.com/search?q=" + Uri.encode(value);
        }
        return "https://" + value;
    }

    private void goBack() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            finish();
        }
    }

    @Override
    public void onBackPressed() {
        goBack();
    }

    @Override
    protected void onDestroy() {
        openWindow.clear();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
