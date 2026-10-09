package com.todo.app.data

import java.io.IOException

enum class WebDavContext { PERSONAL_SYNC, SHARE_GENERATION, COLLABORATION }

open class WebDavHttpException(val status: Int, val operation: String,
    val context: WebDavContext = WebDavContext.PERSONAL_SYNC,
    message: String = webDavHttpMessage(status, context)) : IOException(message)

class WebDavNetworkException(val context: WebDavContext, val operation: String? = null) : IOException(
    if (context == WebDavContext.COLLABORATION) "无法连接分享者服务器，请检查地址和网络后重试。"
    else "无法连接你的 WebDAV 服务器，请检查地址和网络后重试。")

fun webDavHttpMessage(status: Int, context: WebDavContext): String = when (status) {
    401 -> if (context == WebDavContext.COLLABORATION)
        "分享码中的 WebDAV 凭据认证失败（401）。请分享者检查同步配置，并重新生成分享码后导入。"
        else "你的 WebDAV 认证失败（401）。请检查“设置 → 同步”中的账号和第三方应用密码，保存后重试。"
    403 -> if (context == WebDavContext.COLLABORATION) "服务器拒绝访问（403），请分享者检查访问权限。"
        else "服务器拒绝访问（403），请检查你的 WebDAV 访问权限。"
    404 -> if (context == WebDavContext.COLLABORATION) "分享者待办文件不存在（404），请分享者确认路径并完成一次同步。"
        else "你的待办文件不存在（404），请检查同步路径并完成一次同步。"
    in 300..399 -> "服务器返回重定向（$status），请确认 WebDAV 目标地址后重试。"
    else -> "WebDAV 请求失败（$status），请稍后重试。"
}
