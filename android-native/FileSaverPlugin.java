package com.jasoncousineausolutions.tileplanner;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;

// Opens Android's own Save dialog (choose the folder and the file name) and writes the file there.
// JS: Capacitor.Plugins.FileSaver.saveFile({ filename, mimeType, data })  (data is base64)
//     -> { saved: true, name } or { saved: false } if the person cancelled.
@CapacitorPlugin(name = "FileSaver")
public class FileSaverPlugin extends Plugin {

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
