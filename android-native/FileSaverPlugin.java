package com.jasoncousineausolutions.tileplanner;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.OutputStream;
import java.util.Date;
import java.util.List;

// Opens Android's own Save dialog (choose the folder and the file name) and writes the file there.
// JS: Capacitor.Plugins.FileSaver.saveFile({ filename, mimeType, data })  (data is base64)
//     -> { saved: true, name } or { saved: false } if the person cancelled.
// JS: Capacitor.Plugins.FileSaver.lastCrash()  -> { text } describing how the app last closed unexpectedly (once), or {}.
@CapacitorPlugin(name = "FileSaver")
public class FileSaverPlugin extends Plugin {

    // Why the app last closed unexpectedly: the Java error saved by MainActivity, and Android's own record of how the process ended.
    @PluginMethod
    public void lastCrash(PluginCall call) {
        StringBuilder text = new StringBuilder();
        try {
            File file = new File(getContext().getFilesDir(), "last-crash.txt");
            if (file.exists()) {
                try (BufferedReader in = new BufferedReader(new FileReader(file))) {
                    String line;
                    int lines = 0;
                    while ((line = in.readLine()) != null && lines++ < 25) text.append(line).append('\n');
                }
                file.delete();
            }
        } catch (Exception e) {
            text.append("(could not read the saved error: ").append(e.getMessage()).append(")\n");
        }
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
                List<ApplicationExitInfo> exits = am.getHistoricalProcessExitReasons(null, 0, 1);
                SharedPreferences prefs = getContext().getSharedPreferences("exit-report", Context.MODE_PRIVATE);
                if (!exits.isEmpty()) {
                    ApplicationExitInfo info = exits.get(0);
                    int reason = info.getReason();
                    boolean ordinary = reason == ApplicationExitInfo.REASON_EXIT_SELF || reason == ApplicationExitInfo.REASON_USER_REQUESTED
                            || reason == ApplicationExitInfo.REASON_USER_STOPPED || reason == ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE
                            || reason == ApplicationExitInfo.REASON_PACKAGE_UPDATED;
                    if (!ordinary && info.getTimestamp() > prefs.getLong("reported", 0)) {
                        text.append("Android says: reason ").append(reason).append(", status ").append(info.getStatus())
                                .append(", ").append(info.getDescription()).append(", ").append(new Date(info.getTimestamp())).append('\n');
                        text.append("(reasons: 2 killed, 3 low memory, 4 crash, 5 native crash, 6 not responding)\n");
                        prefs.edit().putLong("reported", info.getTimestamp()).apply();
                    }
                }
            }
        } catch (Exception e) {
            // no exit record available
        }
        JSObject result = new JSObject();
        if (text.length() > 0) result.put("text", text.toString());
        call.resolve(result);
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.reject("No data to save.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mimeType", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("filename", "tile-design.json"));
        startActivityForResult(call, intent, "saveFileResult");
    }

    @ActivityCallback
    private void saveFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("saved", false);
            call.resolve(cancelled);
            return;
        }
        Uri uri = result.getData().getData();
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new java.io.IOException("Could not open the file.");
            out.write(Base64.decode(call.getString("data"), Base64.DEFAULT));
        } catch (Exception e) {
            call.reject("Could not write the file: " + e.getMessage());
            return;
        }
        JSObject saved = new JSObject();
        saved.put("saved", true);
        saved.put("name", displayName(uri, call.getString("filename", "")));
        call.resolve(saved);
    }

    private String displayName(Uri uri, String fallback) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception e) {
            // keep the suggested name
        }
        return fallback;
    }
}
