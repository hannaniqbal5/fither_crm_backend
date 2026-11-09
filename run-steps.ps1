# Step 1: Run migrations
$mysql = "C:\xampp\mysql\bin\mysql.exe"
$db = "fithercrm"

Write-Host "=== Running Migrations ===" -ForegroundColor Cyan

Write-Host "Migration 033 (conversion reversal)..."
& $mysql -u root $db -e "SOURCE C:/Users/dell/Desktop/crm/fithercrm-p2` 2/migrations/033_conversion_reversal.sql"

Write-Host "Migration 034 (auto campaigns)..."
& $mysql -u root $db -e "SOURCE C:/Users/dell/Desktop/crm/fithercrm-p2` 2/migrations/034_auto_campaigns.sql"

Write-Host "Migration 035 (auto takeover)..."
& $mysql -u root $db -e "SOURCE C:/Users/dell/Desktop/crm/fithercrm-p2` 2/migrations/035_auto_takeover.sql"

Write-Host "Verifying..."
& $mysql -u root $db -e "SHOW TABLES LIKE 'auto_%'"

# Step 2: Commit and push CRM backend
Write-Host "`n=== CRM Backend ===" -ForegroundColor Cyan
Set-Location "C:\Users\dell\Desktop\crm\fithercrm-p2 2"
git add migrations/033_conversion_reversal.sql migrations/034_auto_campaigns.sql migrations/035_auto_takeover.sql run-migrations.ps1 run-steps.ps1 src/ai/journeyContext.js src/ai/prompt.builder.js src/ai/reply.service.js src/routes/autoCampaign.routes.js src/routes/autoTakeover.routes.js src/routes/automationMetrics.routes.js src/routes/trialLink.routes.js src/services/autoCampaign.service.js src/services/autoTakeover.service.js src/services/repAttribution.service.js src/services/owner.service.js src/app_integration/handlers.js src/App.js
git commit -m "Add auto campaign engine, Fiza takeover, journey-aware AI, automation metrics

Auto campaigns: trigger-based rules with guard rails + WhatsApp delivery.
Fiza auto-takeover: manager-defined rules, full AI pipeline with journey context.
Journey-aware AI: stage-specific prompt blocks for contextual responses.
Payment reversal: soft-delete pattern for frozen/expired subscriptions.
Automation metrics API for campaign/takeover/rep-speed stats.
Migrations: 033, 034, 035.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ptdbWCasnXCmxxRWrfue5"
git push
Write-Host "CRM backend pushed!" -ForegroundColor Green

# Step 3: Commit and push Dashboard
Write-Host "`n=== Dashboard ===" -ForegroundColor Cyan
Set-Location "C:\Users\dell\Desktop\crm\fither-dashboardd"
git add src/admin/AdminAutoCampaignsTab.jsx src/admin/AdminAutoTakeoverTab.jsx src/admin/AdminAutomationMetricsTab.jsx src/adminPannel.js src/components/SendTrialLinkButton.jsx src/components/LeadDetailPanel.jsx
git commit -m "Add auto campaigns, Fiza takeover, automation metrics dashboard tabs

Auto Campaigns tab: create/edit trigger-based campaign rules.
Fiza Takeover tab: manager defines when AI steps in for slow reps.
Automation Metrics tab: live stats for campaigns, takeovers, rep speed.
SendTrialLinkButton: generate and share trial deep links.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ptdbWCasnXCmxxRWrfue5"
git push
Write-Host "Dashboard pushed!" -ForegroundColor Green

Write-Host "`n=== All done! ===" -ForegroundColor Green
