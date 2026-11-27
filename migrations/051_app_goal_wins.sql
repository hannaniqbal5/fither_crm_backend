-- 051_app_goal_wins.sql (Nov 2026)
-- The goal she picked in the app is her goal (services/goalMap.js). Copy it
-- over main_goal for every lead that has one. Same order as goalMap.fromApp;
-- wording the map doesn't recognise leaves main_goal as it is.
UPDATE leads SET main_goal = CASE
    WHEN LOWER(main_goal_app) REGEXP 'pcos|pcod' THEN 'pcos'
    WHEN LOWER(main_goal_app) REGEXP 'post.?partum|after (delivery|baby|pregnan)|delivery|new mom' THEN 'postpartum'
    WHEN LOWER(main_goal_app) REGEXP 'diabet|sugar|insulin' THEN 'diabetes'
    WHEN LOWER(main_goal_app) REGEXP 'gain' THEN 'weight_gain'
    WHEN LOWER(main_goal_app) REGEXP 'lose|loss|reduc|fat|slim|weight' THEN 'weight_loss'
    WHEN LOWER(main_goal_app) REGEXP 'wellness|fit|health|general|tone|toning|strength|active|energy|stress' THEN 'general'
    ELSE main_goal END,
  goal_detected_at = COALESCE(goal_detected_at, NOW())
WHERE main_goal_app IS NOT NULL AND TRIM(main_goal_app) <> '';
