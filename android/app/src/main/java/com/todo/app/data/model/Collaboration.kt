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
    @SerialName("expire_at") val expireAt: Long? = null, // Unix 时间戳（秒），null 表示永久
    @SerialName("updated_at") val updatedAt: String = "", // 用于冲突合并的 ISO 8601 时间戳
    val deleted: Boolean = false // 软删除标记
)

@Serializable
data class CollaborationData(
    val version: Int = 1,
    @SerialName("last_updated") val lastUpdated: String = "",
    val collaborations: List<CollaborationSource> = emptyList()
)

@Serializable
data class ShareCodePayload(
    val url: String,
    val user: String,
    val pass: String,
    val path: String,
    val exp: Long = 0 // 0 表示永久
)
