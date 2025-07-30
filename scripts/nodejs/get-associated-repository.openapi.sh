#!/bin/bash

# Associated Repositories Analyzer - Command Examples

# Basic Commands
# ==============

# Basic analysis with CSV file
node main.mjs --csvFile users.csv

# Analysis with specific output format
node main.mjs --csvFile team-members.csv --format json
node main.mjs --csvFile team-members.csv --format csv

# Analysis with custom output directory and filename
node main.mjs --csvFile users.csv --outputDir ./reports --filename team-analysis

# Verbose and Debug Modes
# =======================

# Enable verbose logging for detailed progress tracking
node main.mjs --csvFile users.csv --verbose

# Enable debug mode with audit file generation
node main.mjs --csvFile users.csv --debug

# Combined verbose and debug for maximum visibility
node main.mjs --csvFile users.csv --verbose --debug

# Real-World Use Cases
# ===================

# Security audit - analyze team members' repository access
node main.mjs --csvFile security-audit.csv --ignoreDateRange --debug --meta-tags "audit=security" "review-date=2024-12-01"

# Team productivity analysis with date range
node main.mjs --csvFile team-members.csv --start 2024-01-01 --end 2024-12-31 --verbose --filename productivity-2024

# Organization-specific repository analysis
node main.mjs --csvFile contributors.csv --org github --format csv --outputDir ./org-analysis

# Large-scale analysis with rate limiting
node main.mjs --csvFile large-team.csv --delay 3 --totalRecords 1000 --verbose

# Contributors analysis for specific repositories
node main.mjs --csvFile contributors.csv --repo "git,jekyll,express" --start 2024-01-01

# Generate Output Formats
# =======================

# JSON format (default) with comprehensive data
node main.mjs --csvFile users.csv --format json --filename detailed-analysis

# CSV format for spreadsheet compatibility
node main.mjs --csvFile users.csv --format csv --filename spreadsheet-export

# Both formats with metadata tags
node main.mjs --csvFile team.csv --format json --meta-tags "team=engineering" "quarter=Q4-2024"
node main.mjs --csvFile team.csv --format csv --meta-tags "team=engineering" "quarter=Q4-2024"

# Various CLI Argument Options
# ============================

# Custom GitHub token (alternative to environment variable)
node main.mjs --csvFile users.csv --token ghp_your_token_here

# Load external data file at runtime
node main.mjs --csvFile users.csv --loadData ./config/team-data.json

# Ignore date range completely
node main.mjs --csvFile all-users.csv --ignoreDateRange --totalRecords 500

# Fine-tune API rate limiting
node main.mjs --csvFile users.csv --delay 2 --verbose # 2 second delay between requests
node main.mjs --csvFile users.csv --delay 10 # 10 second delay for very cautious rate limiting

# Organization and repository filtering
node main.mjs --csvFile users.csv --org "microsoft" --verbose
node main.mjs --csvFile users.csv --repo "react,vue,angular" --debug

# Complete analysis with all options
node main.mjs \
  --csvFile ./data/team-complete.csv \
  --org "github" \
  --repo "git,hub,cli" \
  --format json \
  --outputDir ./complete-analysis \
  --filename comprehensive-report \
  --start 2024-01-01 \
  --end 2024-12-31 \
  --verbose \
  --debug \
  --meta-tags "analysis=comprehensive" "team=platform" "year=2024" \
  --totalRecords 2000 \
  --delay 4

# Streaming and Resume Capability Examples
# ========================================

# Large dataset analysis with checkpoint support (auto-resume on interruption)
node main.mjs --csvFile large-dataset.csv --verbose --delay 5

# Process interruption simulation (Ctrl+C during processing will save progress)
# Resume with the same command - it will continue from where it left off
node main.mjs --csvFile large-dataset.csv --verbose

# Memory-efficient streaming for very large datasets
node main.mjs --csvFile huge-team.csv --totalRecords 10000 --delay 2 --format json

# Specialized Analysis Scenarios
# ===============================

# Open source contributor analysis
node main.mjs --csvFile oss-contributors.csv --ignoreDateRange --meta-tags "type=oss" "project=analysis"

# Enterprise security review
node main.mjs --csvFile enterprise-users.csv --debug --format csv --meta-tags "security=review" "compliance=SOX"

# Acquisition due diligence
node main.mjs --csvFile target-company-devs.csv --verbose --debug --meta-tags "due-diligence=tech-review"

# Research and analytics
node main.mjs --csvFile research-subjects.csv --format json --meta-tags "research=repository-patterns" "study=2024"

# Testing and Development
# =======================

# Quick test with minimal data
node main.mjs --csvFile test-users.csv --totalRecords 5 --delay 1 --verbose

# Development testing with debug output
node main.mjs --csvFile dev-test.csv --debug --outputDir ./dev-output --delay 0.5

# Error handling test (with invalid users)
node main.mjs --csvFile mixed-valid-invalid.csv --verbose --debug

# Performance testing
node main.mjs --csvFile performance-test.csv --totalRecords 100 --delay 0 --format csv

# Integration Examples
# ===================

# Pipeline integration - generate timestamped reports
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
node main.mjs --csvFile daily-users.csv --filename "daily-report-$TIMESTAMP" --format json

# Automated reporting with error handling
if node main.mjs --csvFile users.csv --verbose; then
    echo "Analysis completed successfully"
    # Process the generated report
else
    echo "Analysis failed, check logs"
    exit 1
fi

# Batch processing multiple CSV files
for csv_file in ./data/*.csv; do
    echo "Processing $csv_file"
    node main.mjs --csvFile "$csv_file" --outputDir "./batch-output" --delay 3
done

# Background processing for large datasets
nohup node main.mjs --csvFile massive-dataset.csv --verbose --delay 5 > analysis.log 2>&1 &

# Docker Integration Examples
# ===========================

# Run in container with volume mounting
# docker run -v $(pwd):/workspace -v $(pwd)/data:/data node:20 node /workspace/main.mjs --csvFile /data/users.csv --outputDir /workspace/output

# Environment variable setup for containers
# export GITHUB_TOKEN=your_token
# node main.mjs --csvFile users.csv --verbose

# Help and Information
# ===================

# Show help information
node main.mjs --help

# Show version information
node main.mjs --version
