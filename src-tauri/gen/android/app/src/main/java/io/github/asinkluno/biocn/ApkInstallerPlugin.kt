package io.github.asinkluno.biocn

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/**
 * Android 应用内更新安装插件：
 * - installPermission: 查询「安装未知应用」是否已授权
 * - openInstallPermissionSettings: 跳转本应用的「安装未知应用」授权设置页
 * - installApk: 将已通过 SHA-256 校验的缓存 APK 通过 FileProvider 交给系统安装器
 */
@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun installPermission(invoke: Invoke) {
    val restricted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
    val ret = JSObject()
    ret.put("supported", true)
    ret.put(
      "granted",
      if (restricted) activity.packageManager.canRequestPackageInstalls() else true,
    )
    invoke.resolve(ret)
  }

  @Command
  fun openInstallPermissionSettings(invoke: Invoke) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.startActivity(
          Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${activity.packageName}"),
          ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }
      invoke.resolve(JSObject())
    } catch (e: Exception) {
      invoke.reject(e.message ?: "无法打开安装授权设置")
    }
  }

  /**
   * 只接受 cacheDir/updates 下的 .apk，避免被传入任意路径。
   */
  @Command
  fun installApk(invoke: Invoke) {
    val raw = invoke.getArgs().optString("path")
    try {
      val file = File(raw).canonicalFile
      val root = File(activity.cacheDir, "updates").canonicalFile
      check(file.path.startsWith(root.path + File.separator)) { "安装包路径无效" }
      check(file.name.endsWith(".apk")) { "安装包路径无效" }
      check(file.isFile) { "安装包不存在，请重新下载" }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !activity.packageManager.canRequestPackageInstalls()
      ) {
        invoke.reject("请先允许 BioCN 安装未知应用")
        return
      }
      val uri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.fileprovider",
        file,
      )
      activity.startActivity(
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK,
          ),
      )
      invoke.resolve(JSObject())
    } catch (e: Exception) {
      invoke.reject(e.message ?: "无法启动系统安装器")
    }
  }
}
