# Add project specific ProGuard rules here.
# Keep OkHttp WebSocket
-keep class okhttp3.** { *; }
-dontwarn okhttp3.**

# Keep kotlinx serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
