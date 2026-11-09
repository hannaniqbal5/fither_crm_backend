# Run pending migrations 033, 034, 035
$mysql = "C:\xampp\mysql\bin\mysql.exe"
$db = "fithercrm"

Write-Host "Running migration 033 (conversion reversal)..."
& $mysql -u root $db -e "SOURCE C:/Users/dell/Desktop/crm/fithercrm-p2 2/migrations/033_conversion_reversal.sql"

Write-Host "Running migration 034 (auto campaigns)..."
& $mysql -u root $db -e "SOURCE C:/Users/dell/Desktop/crm/fithercrm-p2 2/migrations/034_auto_campaigns.sql"

Write-Host "Running migration 035 (auto takeover)..."
& $mysql -u root $db -e "SOURCE C:/Users/dell/Desktop/crm/fithercrm-p2 2/migrations/035_auto_takeover.sql"

Write-Host "Verifying tables..."
& $mysql -u root $db -e "SHOW TABLES LIKE 'auto_%'; DESCRIBE auto_campaign_rules; DESCRIBE auto_takeover_rules;"

Write-Host "Done!"
