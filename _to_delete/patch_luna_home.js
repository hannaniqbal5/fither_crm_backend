const fs=require("fs");const root=process.argv[2];
function patch(rel,pairs){const p=root+"/"+rel;let s=fs.readFileSync(p,"utf8");for(const [a,b] of pairs){if(!s.includes(a)) throw new Error(rel+" nf: "+a.slice(0,50)); s=s.replace(a,b);} fs.writeFileSync(p,s);console.log("patched",rel);}
const imp="import '../UI/luna_chat/luna_widgets.dart';\n";
patch("screens/paid_home_screen_v2.dart",[
 ["import ", imp+"import "],
 ["        child: Scaffold(\n          // Cream body bg matches the H-01 reference scroll area below the\n          // hero. Unchanged.\n          backgroundColor: const Color(0xFFEAF7E4),",
  "        child: Scaffold(\n          // Cream body bg matches the H-01 reference scroll area below the\n          // hero. Unchanged.\n          backgroundColor: const Color(0xFFEAF7E4),\n          // Luna chat (Nov 2026): Ask Luna from anywhere on home.\n          floatingActionButton: const LunaFab(),"],
]);
patch("screens/unpaid_home_screen_v2.dart",[
 ["import ", imp+"import "],
 ["      child: Scaffold(\n        backgroundColor: const Color(0xFFF9FCF7),",
  "      child: Scaffold(\n        backgroundColor: const Color(0xFFF9FCF7),\n        // Luna chat (Nov 2026): questions about plans, trial, classes.\n        floatingActionButton: const LunaFab(),"],
]);
patch("widgets/paid_home_v2/paid_insight_card.dart",[
 ["import '../../data/models/home_dashboard/home_dashboard_model.dart';", "import '../../data/models/home_dashboard/home_dashboard_model.dart';\nimport '../../UI/luna_chat/luna_widgets.dart';"],
 [`                  if (body.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      body,
                      style: const TextStyle(
                        fontFamily: 'Poppins',
                        fontSize: 11.5,
                        color: _soft,
                        height: 1.55,
                      ),
                    ),
                  ],`,
 `                  if (body.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      body,
                      style: const TextStyle(
                        fontFamily: 'Poppins',
                        fontSize: 11.5,
                        color: _soft,
                        height: 1.55,
                      ),
                    ),
                  ],
                  // Luna chat (Nov 2026): ask about today's tip.
                  const SizedBox(height: 10),
                  AskLunaPill(prefill: 'About today\\'s tip: '),`],
]);
