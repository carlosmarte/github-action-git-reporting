#!/bin/bash

# GitHub Repository Search Terms Analyzer - Command Examples
# This file contains various command examples for different use cases

# Basic Commands
# =============

# Search for a single term in a specific repository
node main.mjs --contains "bug" --repo "microsoft/TypeScript"

# Search for multiple terms in a repository
node main.mjs --contains "bug" --contains "fix" --contains "error" --repo "facebook/react"

# Search using repository ID instead of name
node main.mjs --contains "security" --repo "1296269"

# Search all repositories of a specific user
node main.mjs --contains "TODO" --searchUser "octocat"

# Search with organization filter
node main.mjs --contains "performance" --org "microsoft"

# Real Work Use Cases
# ==================

# Security audit - search for security-related terms
node main.mjs --contains "password" --contains "token" --contains "secret" --contains "key" --repo "your-org/your-repo" --meta-tags "audit=security" --meta-tags "date=2024-12-26"

# Bug tracking analysis - find all bug-related content
node main.mjs --contains "bug" --contains "error" --contains "exception" --contains "crash" --repo "facebook/react,microsoft/TypeScript" --start "2024-01-01" --end "2024-12-31"

# Code quality review - search for code quality indicators
node main.mjs --contains "TODO" --contains "FIXME" --contains "HACK" --contains "deprecated" --searchUser "your-username" --verbose

# Documentation gaps - find documentation-related issues
node main.mjs --contains "documentation" --contains "readme" --contains "docs" --contains "guide" --repo "nodejs/node" --format "csv"

# Performance analysis - search for performance-related content
node main.mjs --contains "performance" --contains "slow" --contains "optimization" --contains "memory" --repo "vercel/next.js" --totalRecords 100

# Generate Output Formats
# =======================

# Generate JSON report (default)
node main.mjs --contains "test" --repo "jest/jest" --format "json" --filename "jest-test-analysis"

# Generate CSV report for spreadsheet analysis
node main.mjs --contains "api" --repo "expressjs/express" --format "csv" --filename "express-api-analysis"

# Generate report with custom output directory
node main.mjs --contains "react" --repo "facebook/react" --outputDir "./reports/react-analysis"

# Generate debug report with audit trail
node main.mjs --contains "webpack" --repo "webpack/webpack" --debug --filename "webpack-debug-analysis"

# Various CLI Argument Options
# ============================

# Date range filtering
node main.mjs --contains "release" --repo "nodejs/node" --start "2024-01-01" --end "2024-06-30"

# Ignore date range (search all time)
node main.mjs --contains "migration" --repo "rails/rails" --ignoreDateRange

# Verbose logging for detailed output
node main.mjs --contains "database" --repo "prisma/prisma" --verbose

# Debug mode with full audit trail
node main.mjs --contains "graphql" --repo "graphql/graphql-js" --debug

# Custom API delay for rate limiting
node main.mjs --contains "typescript" --repo "microsoft/TypeScript" --delay 10

# Limit total records per search
node main.mjs --contains "react" --searchUser "facebook" --totalRecords 50

# Load external data file
node main.mjs --contains "config" --repo "webpack/webpack" --loadData "./config/repos.json"

# Multiple meta tags for categorization
node main.mjs --contains "security" --repo "OWASP/CheatSheetSeries" --meta-tags "project=security-audit" --meta-tags "version=1.0" --meta-tags "team=security"

# Custom GitHub token (overrides environment variable)
node main.mjs --contains "api" --repo "github/docs" --token "ghp_your_custom_token_here"

# Advanced Use Cases
# =================

# Multi-repository security scan
node main.mjs --contains "password" --contains "secret" --contains "private_key" --repo "org/repo1,org/repo2,org/repo3" --format "csv" --meta-tags "scan=security" --debug

# Open source contribution analysis
node main.mjs --contains "contribution" --contains "contributor" --contains "maintainer" --searchUser "sindresorhus" --start "2024-01-01" --verbose

# Technical debt analysis
node main.mjs --contains "TODO" --contains "FIXME" --contains "HACK" --contains "technical debt" --repo "airbnb/javascript" --format "json" --filename "tech-debt-analysis"

# Release management tracking
node main.mjs --contains "release" --contains "changelog" --contains "version" --repo "semantic-release/semantic-release" --start "2024-01-01" --ignoreDateRange

# API usage analysis
node main.mjs --contains "API" --contains "endpoint" --contains "REST" --contains "GraphQL" --repo "strapi/strapi" --totalRecords 200 --delay 5

# Code migration tracking
node main.mjs --contains "migration" --contains "upgrade" --contains "deprecated" --repo "angular/angular" --format "csv" --outputDir "./migration-reports"

# Batch Processing Examples
# ========================

# Process multiple repositories in sequence
for repo in "facebook/react" "angular/angular" "vuejs/vue"; do
    node main.mjs --contains "component" --repo "$repo" --filename "component-analysis-$(echo $repo | tr '/' '-')" --delay 8
done

# Process with different terms for the same repository
for term in "bug" "feature" "enhancement" "documentation"; do
    node main.mjs --contains "$term" --repo "microsoft/vscode" --filename "vscode-$term-analysis" --format "csv"
done

# Environment-specific examples
# =============================

# Development environment
GITHUB_TOKEN="your_dev_token" node main.mjs --contains "test" --repo "jest/jest" --verbose

# Production environment with error handling
GITHUB_TOKEN="your_prod_token" node main.mjs --contains "production" --repo "your-org/your-app" --debug --outputDir "/var/reports" || echo "Analysis failed"

# CI/CD pipeline integration
node main.mjs --contains "ci" --contains "deploy" --repo "$CI_REPOSITORY" --format "json" --filename "ci-analysis-$CI_BUILD_NUMBER" --meta-tags "build=$CI_BUILD_NUMBER"

# Help and Information
# ===================

# Show help information
node main.mjs --help

# Show version information
node main.mjs --version

# Test connection and rate limits
node main.mjs --contains "test" --repo "octocat/Hello-World" --totalRecords 1 --verbose

# Performance Testing Examples
# ===========================

# Small dataset test
node main.mjs --contains "hello" --repo "octocat/Hello-World" --totalRecords 5 --delay 3

# Medium dataset test
node main.mjs --contains "javascript" --searchUser "sindresorhus" --totalRecords 50 --delay 5

# Large dataset test (use with caution)
node main.mjs --contains "react" --searchUser "facebook" --totalRecords 500 --delay 8 --debug

# Error Handling Examples
# ======================

# Handle network issues with retries (built into rate limiter)
node main.mjs --contains "network" --repo "nodejs/node" --delay 10 --verbose

# Handle API rate limits gracefully
node main.mjs --contains "api" --repo "github/docs" --delay 12 --debug

# Validate repository access
node main.mjs --contains "test" --repo "nonexistent/repository" --verbose 2>&1 | grep -i error

# Integration Examples
# ===================

# Combine with jq for JSON processing
node main.mjs --contains "bug" --repo "facebook/react" --format "json" | jq '.summary'

# Combine with CSV processing tools
node main.mjs --contains "feature" --repo "angular/angular" --format "csv" | head -20

# Export to file and process
node main.mjs --contains "performance" --repo "webpack/webpack" --filename "perf-analysis"
cat "./output/perf-analysis.json" | jq '.summary.totalResults'

# Monitoring and Alerting
# =======================

# Check for security issues and alert if found
results=$(node main.mjs --contains "vulnerability" --repo "your-org/your-repo" --format "json" | jq '.summary.totalResults')
if [ "$results" -gt 0 ]; then
    echo "Security vulnerabilities found: $results"
    # Send alert notification here
fi

# Monitor technical debt over time
node main.mjs --contains "TODO" --repo "your-org/your-repo" --filename "tech-debt-$(date +%Y-%m-%d)" --meta-tags "date=$(date +%Y-%m-%d)"
