package com.todo.app.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class CollaborationSource(
    val id: String,
    var name: String,
    @SerialName("webdav_url") val webdavUrl: String,
    @SerialName("webdav_username") val webdavUsername: String,
    @SerialName("webdav_password") val webdavPassword: String,
    @SerialName("webdav_filepath") val webdavFilepath: String,
    @SerialName("expire_at") val expireAt: Long? = null // Unix 时间戳（秒），null 表示永久
)

@Serializable
data class ShareCodePayload(
    val url: String,
    val user: String,
    val pass: String,
    val path: String,
    val exp: Long = 0 // 0 表示永久
)
