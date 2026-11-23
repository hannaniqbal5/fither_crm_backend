const fs=require("fs");const root=process.argv[2];
function patch(rel, pairs){const p=root+"/"+rel;let s=fs.readFileSync(p,"utf8");for(const [a,b] of pairs){if(!s.includes(a)) throw new Error(rel+": not found: "+a.slice(0,60)); s=s.replace(a,b);} fs.writeFileSync(p,s); console.log("patched",rel);}

// 1. Dart channel: keep the init error code instead of dropping it
patch("lib/zoom_meeting.dart", [
["  static String? lastError;", "  static String? lastError;\n\n  /// Why the last SDK sign-in failed (Zoom's init error code), if it did.\n  static String? initError;"],
["      final bool result =\n          await _channel.invokeMethod('initializeZoom', arguments);\n      return result;\n    } on PlatformException catch (e) {\n      print('Failed to initialize Zoom: ${e.message}');",
 "      final bool result =\n          await _channel.invokeMethod('initializeZoom', arguments);\n      initError = null;\n      return result;\n    } on PlatformException catch (e) {\n      // e.details = Zoom's init error code (e.g. 3 = auth/JWT rejected).\n      initError = 'init ${e.code} zoom_code=${e.details ?? '?'}';\n      print('Failed to initialize Zoom: ${e.message} ($initError)');"],
["      ZoomMeeting.lastError = 'sdk_not_initialized';", "      ZoomMeeting.lastError = 'sdk_not_initialized ${ZoomMeeting.initError ?? ''}'.trim();"],
]);

// 2. Native: send init error code + SDK version; log join return code
patch("android/app/src/main/kotlin/com/abtechnologies/fitHer/MainActivity.kt", [
["            Log.d(TAG, \"Zoom SDK initialized successfully\")",
 "            Log.d(TAG, \"Zoom SDK initialized successfully, version=\" + try { ZoomSDK.getInstance().getVersion(applicationContext) } catch (e: Exception) { \"?\" })"],
["            pendingInitResult?.error(\"INIT_FAILED\", \"Initialization failed\", \"$errorCode\")",
 "            pendingInitResult?.error(\"INIT_FAILED\", \"Initialization failed\", \"$errorCode/$internalErrorCode\")"],
]);

// 3. Controller: log the async "meeting_failed" code (Zoom refused AFTER accepting the request)
patch("lib/data/controllers/zoom_controller.dart", [
["    final eventName = event['event']?.toString() ?? '';",
 "    final eventName = event['event']?.toString() ?? '';\n    if (eventName == 'meeting_failed') {\n      // e.g. 4012 = app can't join meetings outside its Zoom account anonymously.\n      ZoomMeeting.lastError = 'meeting_failed code=${event['errorCode']} internal=${event['internalErrorCode']}';\n      debugPrint('[zoom] ${ZoomMeeting.lastError}');\n      AnalyticsHelper.workoutJoinFailed('zoom_error ${ZoomMeeting.lastError}', slotId: _activeSlotId);\n    }"],
["import 'package:get/get.dart';", "import 'package:flutter/foundation.dart';\nimport 'package:get/get.dart';\nimport '../../helper/analytics_helper.dart';"],
]);

// 4. Popup: show the reason on screen in debug builds only
patch("lib/widgets/app_bar_widget.dart", [
["        lines: const [\n          'Your class is live. Tap Try again, or open it in the Zoom app.',\n        ],",
 "        lines: [\n          'Your class is live. Tap Try again, or open it in the Zoom app.',\n          // Debug builds only: Zoom's real reason, for testing.\n          if (kDebugMode) 'Debug: ${ZoomMeeting.lastError ?? 'no code'}',\n        ],"],
]);
