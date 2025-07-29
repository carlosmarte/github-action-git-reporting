// main.mjs
/**
 * Project Name: Associated Repos Analyzer
 * Purpose: Query GitHub API to provide comprehensive list of associated repositories (public/private) for users
 * Description: A robust CLI tool that analyzes GitHub repositories associated with users from CSV input or single user search,
 *              providing detailed reporting on repository ownership, contributions, and metadata
 * Requirements Summary:
 *   - Parse CSV file containing user identifiers or analyze single user via --searchUser
 *   - Query GitHub API for associated repositories (public/private)
 *   - Handle pagination, rate limiting, and API errors gracefully
 *   - Generate comprehensive reports in JSON/CSV format with metadata
 *   - Support filtering by organization, repository, and date ranges
 *   - Provide detailed audit logging and GitHub API usage tracking
 * 
 * JSON Report Structure Example:
 * {
 *   "inputs": { "csvFile": "users.csv", "format": "json", "start": "2024-01-01", "end": "2024-12-31" },
 *   "metaTags": { "project": "analysis-2024", "team": "dev-ops" },
 *   "summary": {
 *     "totalUsers": 5,
 *     "totalRepositories": 45,
 *     "publicRepos": 40,
 *     "privateRepos": 5,
 *     "organizationRepos": 12,
 *     "personalRepos": 33
 *   },
 *   "users": [
 *     {
 *       "username": "johndoe",
 *       "profile": { "name": "John Doe", "email": "john@example.com", "company": "Tech Corp" },
 *       "repositories": [
 *         {
 *           "name": "awesome-project",
 *           "fullName": "johndoe/awesome-project",
 *           "private": false,
 *           "owner": "johndoe",
 *           "description": "An awesome project",
 *           "language": "JavaScript",
 *           "stars": 150,
 *           "forks": 25,
 *           "createdAt": "2024-01-15T10:30:00Z",
 *           "updatedAt": "2024-06-20T14:45:00Z",
 *           "url": "https://github.com/johndoe/awesome-project"
 *         }
 *       ],
 *       "repositoryStats": {
 *         "total": 8,
 *         "public": 7,
 *         "private": 1,
 *         "byLanguage": { "JavaScript": 4, "Python": 3, "Go": 1 }
 *       }
 *     }
 *   ],
 *   "criteria": ["Active repositories", "Date range filter applied", "Public and private repos included"],
 *   "formula": ["Repository count = owned + contributed", "Language distribution by primary language"],
 *   "insights": ["Most active language: JavaScript", "Average repositories per user: 9", "High collaboration indicated by fork counts"]
 * }
 * 
 * Potential Insights:
 * - Repository ownership patterns and activity levels
 * - Programming language preferences and expertise areas
 * - Collaboration patterns through forks and contributions
 * - Organization vs personal repository distribution
 * - Repository creation and update activity over time
 */

import { Command } from 'commander';
import { Octokit } from 'octokit';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import chalk from 'chalk';
import { z } from 'zod';
import { API_Rate_Limiter } from '@thinkeloquent/npm-api-rate-limiter';
import { CLIProgressHelper, ProgressBar, Colors } from '@thinkeloquent/cli-progressor';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Validation schemas
const UserSchema = z.object({
  username: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().optional()
});

const RepositorySchema = z.object({
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  owner: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  stars: z.number(),
  forks: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string()
});

const ReportSchema = z.object({
  inputs: z.object({
    csvFile: z.string().optional(),
    searchUser: z.string().optional(),
    format: z.string(),
    start: z.string(),
    end: z.string()
  }),
  metaTags: z.record(z.string()),
  summary: z.object({
    totalUsers: z.number(),
    totalRepositories: z.number(),
    publicRepos: z.number(),
    privateRepos: z.number(),
    organizationRepos: z.number(),
    personalRepos: z.number()
  }),
  users: z.array(z.object({
    username: z.string(),
    profile: z.object({
      name: z.string().nullable(),
      email: z.string().nullable(),
      company: z.string().nullable()
    }),
    repositories: z.array(RepositorySchema),
    repositoryStats: z.object({
      total: z.number(),
      public: z.number(),
      private: z.number(),
      byLanguage: z.record(z.number())
    })
  })),
  criteria: z.array(z.string()),
  formula: z.array(z.string()),
  insights: z.array(z.string())
});

class AssociatedRepos {
  constructor(options = {}) {
    this.options = {
      ...options,
      token: options.token || process.env.GITHUB_TOKEN,
      baseURL: options.baseURL || process.env.GITHUB_BASE_API_URL || 'https://api.github.com',
      verbose: options.verbose || false,
      debug: options.debug || false
    };

    if (!this.options.token) {
      throw new Error('GitHub token is required. Set GITHUB_TOKEN environment variable or use --token');
    }

    this.octokit = new Octokit({
      auth: this.options.token,
      baseUrl: this.options.baseURL
    });

    // Initialize rate limiters for different GitHub API resources
    this.setupRateLimiters();
    
    this.apiCalls = [];
    this.errors = [];
    this.logFile = this.options.debug ? 'github.log' : null;
  }

  setupRateLimiters() {
    // Core API limiter (repositories, users, etc.)
    this.coreLimiter = new API_Rate_Limiter('github-core-repos', {
      getRateLimitStatus: () => this.getGitHubRateLimit('core')
    });

    // Search API limiter (searching repositories)
    this.searchLimiter = new API_Rate_Limiter('github-search-repos', {
      getRateLimitStatus: () => this.getGitHubRateLimit('search')
    });
  }

  async getGitHubRateLimit(resource = 'core') {
    try {
      const response = await this.octokit.request('GET /rate_limit');
      const limit = response.data.resources[resource];
      return {
        remaining: limit.remaining,
        reset: limit.reset
      };
    } catch (error) {
      console.error(`Failed to get rate limit for ${resource}:`, error.message);
      return { remaining: 1, reset: Math.floor(Date.now() / 1000) + 60 };
    }
  }

  logRequest(method, url, response = null, error = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      method,
      url,
      response: response ? { status: response.status, data: response.data } : null,
      error: error ? error.message : null
    };

    this.apiCalls.push({ method, url });
    
    if (error) {
      this.errors.push(logEntry);
    }

    if (this.options.verbose) {
      console.log(chalk.gray(`API Call: ${method} ${url}`));
    }

    if (this.logFile) {
      const logLine = JSON.stringify(logEntry) + '\n';
      try {
        const fs = await import('fs');
        fs.appendFileSync(this.logFile, logLine);
      } catch (err) {
        console.error('Failed to write to log file:', err.message);
      }
    }
  }

  async makeRequest(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.options.baseURL}${endpoint}`;
    
    try {
      const response = await this.octokit.request(`GET ${endpoint}`, options);
      this.logRequest('GET', url, response);
      return response.data;
    } catch (error) {
      this.logRequest('GET', url, null, error);
      throw error;
    }
  }

  async validateUser(username) {
    try {
      const userData = await this.coreLimiter.schedule(async () => {
        return this.makeRequest(`/users/${username}`);
      });
      
      return {
        username: userData.login,
        name: userData.name,
        email: userData.email,
        company: userData.company,
        publicRepos: userData.public_repos,
        followers: userData.followers,
        following: userData.following
      };
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`User '${username}' not found`);
      }
      throw error;
    }
  }

  async getUserRepositories(username, options = {}) {
    const { start, end, org, repoFilter, ignoreDateRange, totalRecords } = options;
    let allRepos = [];

    try {
      // Get user's own repositories
      await CLIProgressHelper.withProgress(
        1,
        `Fetching repositories for user: ${username}`,
        async (updateProgress) => {
          let page = 1;
          const perPage = 100;
          let hasMore = true;
          let repoCount = 0;

          while (hasMore && (totalRecords === 0 || repoCount < totalRecords)) {
            const repos = await this.coreLimiter.schedule(async () => {
              return this.makeRequest(`/users/${username}/repos`, {
                page,
                per_page: perPage,
                sort: 'updated',
                direction: 'desc'
              });
            });

            if (repos.length === 0) {
              hasMore = false;
              break;
            }

            // Filter repositories based on criteria
            const filteredRepos = this.filterRepositories(repos, {
              start,
              end,
              org,
              repoFilter,
              ignoreDateRange
            });

            allRepos.push(...filteredRepos);
            repoCount += filteredRepos.length;
            page++;

            if (repos.length < perPage) {
              hasMore = false;
            }

            // Add delay to respect rate limits
            await this.delay(this.options.delay || 2);
          }

          updateProgress(1);
        }
      );

      // Search for repositories where user is a contributor
      const contributedRepos = await this.searchUserContributions(username, options);
      
      // Merge and deduplicate repositories
      const repoMap = new Map();
      [...allRepos, ...contributedRepos].forEach(repo => {
        repoMap.set(repo.full_name, repo);
      });

      return Array.from(repoMap.values()).map(repo => this.formatRepository(repo));
    } catch (error) {
      console.error(chalk.red(`Failed to fetch repositories for ${username}: ${error.message}`));
      return [];
    }
  }

  async searchUserContributions(username, options = {}) {
    const { start, end, ignoreDateRange } = options;
    let contributedRepos = [];

    try {
      // Search for repositories where user has commits
      const queries = [
        `author:${username}`,
        `committer:${username}`
      ];

      if (!ignoreDateRange && start && end) {
        queries.forEach((query, index) => {
          queries[index] = `${query}+committer-date:${start}..${end}`;
        });
      }

      for (const query of queries) {
        await CLIProgressHelper.withProgress(
          1,
          `Searching contributions: ${query}`,
          async (updateProgress) => {
            try {
              // Use time-based partitioning to handle >1000 results
              const repos = await this.searchWithPartitioning(query, 'repositories');
              contributedRepos.push(...repos);
              updateProgress(1);
            } catch (error) {
              console.error(chalk.red(`Search failed for query "${query}": ${error.message}`));
            }
          }
        );
      }

      return contributedRepos;
    } catch (error) {
      console.error(chalk.red(`Failed to search contributions for ${username}: ${error.message}`));
      return [];
    }
  }

  async searchWithPartitioning(baseQuery, type = 'repositories') {
    const results = [];
    const currentDate = new Date();
    const oneYearAgo = new Date(currentDate.getFullYear() - 1, currentDate.getMonth(), currentDate.getDate());
    
    // Partition by months to handle >1000 result limit
    const months = [];
    let current = new Date(oneYearAgo);
    
    while (current <= currentDate) {
      const start = new Date(current);
      const end = new Date(current.getFullYear(), current.getMonth() + 1, 0);
      if (end > currentDate) end.setTime(currentDate.getTime());
      
      months.push({
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0]
      });
      
      current.setMonth(current.getMonth() + 1);
    }

    for (const month of months) {
      const query = `${baseQuery}+created:${month.start}..${month.end}`;
      
      try {
        let page = 1;
        let hasMore = true;
        
        while (hasMore) {
          const response = await this.searchLimiter.schedule(async () => {
            return this.makeRequest('/search/repositories', {
              q: query,
              page,
              per_page: 100,
              sort: 'updated',
              order: 'desc'
            });
          });

          results.push(...response.items);
          
          if (response.items.length < 100 || results.length >= response.total_count) {
            hasMore = false;
          } else {
            page++;
          }

          // Add delay for search API rate limiting
          await this.delay(this.options.delay || 6);
        }
      } catch (error) {
        console.error(chalk.yellow(`Warning: Search failed for ${query}: ${error.message}`));
      }
    }

    return results;
  }

  filterRepositories(repos, options = {}) {
    const { start, end, org, repoFilter, ignoreDateRange } = options;
    
    return repos.filter(repo => {
      // Organization filter
      if (org && repo.owner.login !== org) {
        return false;
      }

      // Repository name filter
      if (repoFilter) {
        const repoNames = repoFilter.split(',').map(name => name.trim());
        if (!repoNames.includes(repo.name)) {
          return false;
        }
      }

      // Date range filter
      if (!ignoreDateRange && start && end) {
        const repoDate = new Date(repo.created_at);
        const startDate = new Date(start);
        const endDate = new Date(end);
        
        if (repoDate < startDate || repoDate > endDate) {
          return false;
        }
      }

      return true;
    });
  }

  formatRepository(repo) {
    return {
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      owner: repo.owner.login,
      description: repo.description,
      language: repo.language,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      createdAt: repo.created_at,
      updatedAt: repo.updated_at,
      url: repo.html_url,
      size: repo.size,
      openIssues: repo.open_issues_count,
      defaultBranch: repo.default_branch,
      archived: repo.archived,
      disabled: repo.disabled
    };
  }

  parseCsvFile(filePath) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim());
      
      const users = lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.trim());
        const user = {};
        
        headers.forEach((header, index) => {
          user[header] = values[index] || '';
        });
        
        return user;
      });

      return users;
    } catch (error) {
      throw new Error(`Failed to parse CSV file: ${error.message}`);
    }
  }

  calculateInsights(users) {
    const insights = [];
    const allRepos = users.flatMap(user => user.repositories);
    
    if (allRepos.length === 0) {
      return ['No repositories found for analysis'];
    }

    // Language analysis
    const languages = {};
    allRepos.forEach(repo => {
      if (repo.language) {
        languages[repo.language] = (languages[repo.language] || 0) + 1;
      }
    });

    const topLanguage = Object.entries(languages)
      .sort(([,a], [,b]) => b - a)[0];
    
    if (topLanguage) {
      insights.push(`Most popular language: ${topLanguage[0]} (${topLanguage[1]} repositories)`);
    }

    // Repository activity
    const avgReposPerUser = (allRepos.length / users.length).toFixed(1);
    insights.push(`Average repositories per user: ${avgReposPerUser}`);

    // Stars and forks analysis
    const totalStars = allRepos.reduce((sum, repo) => sum + repo.stars, 0);
    const totalForks = allRepos.reduce((sum, repo) => sum + repo.forks, 0);
    
    if (totalStars > 0) {
      insights.push(`Total stars across all repositories: ${totalStars}`);
    }
    
    if (totalForks > 0) {
      insights.push(`Total forks indicating collaboration: ${totalForks}`);
    }

    // Recent activity
    const recentRepos = allRepos.filter(repo => {
      const updated = new Date(repo.updatedAt);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      return updated > thirtyDaysAgo;
    });

    insights.push(`${recentRepos.length} repositories updated in the last 30 days`);

    return insights;
  }

  async generateReport(users, options) {
    const { format, outputDir, filename, metaTags = {} } = options;
    
    // Calculate summary statistics
    const allRepos = users.flatMap(user => user.repositories);
    const publicRepos = allRepos.filter(repo => !repo.private).length;
    const privateRepos = allRepos.filter(repo => repo.private).length;
    const organizationRepos = allRepos.filter(repo => repo.owner !== repo.fullName.split('/')[0]).length;
    const personalRepos = allRepos.length - organizationRepos;

    const report = {
      inputs: {
        csvFile: options.csvFile,
        searchUser: options.searchUser,
        format: options.format,
        start: options.start,
        end: options.end,
        org: options.org,
        repo: options.repo
      },
      metaTags,
      summary: {
        totalUsers: users.length,
        totalRepositories: allRepos.length,
        publicRepos,
        privateRepos,
        organizationRepos,
        personalRepos,
        analysisDate: new Date().toISOString()
      },
      users,
      criteria: [
        'Repositories owned by user',
        'Repositories where user is a contributor',
        options.ignoreDateRange ? 'All time period' : `Date range: ${options.start} to ${options.end}`,
        options.org ? `Organization filter: ${options.org}` : 'All organizations',
        'Both public and private repositories included'
      ],
      formula: [
        'Total repositories = owned repositories + contributed repositories (deduplicated)',
        'Repository stats calculated per user',
        'Language distribution based on primary repository language',
        'Organization vs personal classification based on repository owner'
      ],
      insights: this.calculateInsights(users)
    };

    // Validate report structure
    ReportSchema.parse(report);

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const baseFilename = filename || `associated-repos-${timestamp}`;
    const filePath = join(outputDir, `${baseFilename}.${format}`);

    if (format === 'json') {
      writeFileSync(filePath, JSON.stringify(report, null, 2));
    } else if (format === 'csv') {
      const csvContent = this.convertToCSV(report);
      writeFileSync(filePath, csvContent);
    }

    // Generate audit file if debug mode is enabled
    if (options.debug) {
      const auditData = {
        apiCalls: this.apiCalls,
        errors: this.errors,
        rateLimitCalls: await this.getRateLimitStatus(),
        generatedAt: new Date().toISOString()
      };
      
      const auditPath = join(outputDir, `${baseFilename}.audit.json`);
      writeFileSync(auditPath, JSON.stringify(auditData, null, 2));
      console.log(chalk.blue(`📄 Audit file saved: ${auditPath}`));
    }

    return { filePath, report };
  }

  convertToCSV(report) {
    const headers = [
      'Username', 'Name', 'Email', 'Company',
      'Repository Name', 'Full Name', 'Private', 'Owner',
      'Description', 'Language', 'Stars', 'Forks',
      'Created At', 'Updated At', 'URL'
    ];

    const rows = [headers.join(',')];

    report.users.forEach(user => {
      user.repositories.forEach(repo => {
        const row = [
          user.username,
          user.profile.name || '',
          user.profile.email || '',
          user.profile.company || '',
          repo.name,
          repo.fullName,
          repo.private,
          repo.owner,
          repo.description || '',
          repo.language || '',
          repo.stars,
          repo.forks,
          repo.createdAt,
          repo.updatedAt,
          repo.url
        ].map(field => `"${String(field).replace(/"/g, '""')}"`);
        
        rows.push(row.join(','));
      });
    });

    return rows.join('\n');
  }

  async delay(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }

  async getRateLimitStatus() {
    try {
      const data = await this.makeRequest('/rate_limit');
      return data.resources;
    } catch (error) {
      console.error(chalk.red('Failed to fetch rate limit status'));
      return null;
    }
  }

  async showRateLimit() {
    try {
      const data = await this.makeRequest('/rate_limit');
      const { rate } = data;

      console.log(chalk.blue.bold('\n📊 GitHub API Rate Limit Status:'));
      console.log(`   Limit: ${chalk.green.bold(rate.limit)}`);
      console.log(`   Remaining: ${chalk.green.bold(rate.remaining)}`);
      console.log(`   Used: ${chalk.yellow.bold(rate.used)}`);
      console.log(`   Resets at: ${chalk.gray(new Date(rate.reset * 1000).toLocaleString())}`);

      if (rate.remaining < 10) {
        console.log(chalk.red.bold('   ⚠️  Warning: Rate limit is low!'));
      }
    } catch (error) {
      console.error(chalk.red('❌ Failed to fetch rate limit information'));
    }
  }

  displaySummary(options, report) {
    console.log(chalk.blue.bold('\n🔸 Initialization'));
    console.log(chalk.green('🔧 AssociatedRepos initialized'));
    
    console.log('\nParameter'.padEnd(25) + 'Value');
    console.log('─'.repeat(50));
    console.log(`📊 Rate limit`.padEnd(25) + chalk.green('Dynamic'));
    console.log(`👤 Search user`.padEnd(25) + chalk.yellow(options.searchUser || 'From CSV'));
    console.log(`📁 CSV file`.padEnd(25) + chalk.yellow(options.csvFile || 'Not specified'));
    console.log(`📅 Date range`.padEnd(25) + chalk.yellow(`${options.start} to ${options.end}`));
    console.log(`🏢 Organization`.padEnd(25) + chalk.yellow(options.org || 'All organizations'));
    console.log(`📂 Repositories`.padEnd(25) + chalk.yellow(options.repo || 'All repositories'));
    console.log(`📄 Output format`.padEnd(25) + chalk.yellow(options.format));
    console.log(`💾 Output directory`.padEnd(25) + chalk.yellow(options.outputDir));
    console.log(`🔍 Verbose mode`.padEnd(25) + chalk.yellow(options.verbose ? 'Enabled' : 'Disabled'));
    console.log(`🐛 Debug mode`.padEnd(25) + chalk.yellow(options.debug ? 'Enabled' : 'Disabled'));

    if (report) {
      console.log(chalk.blue.bold('\n📊 Final Report Summary'));
      console.log('─'.repeat(60));
      console.log(`📊 Total Users`.padEnd(25) + `: ${chalk.green.bold(report.summary.totalUsers)}`);
      console.log(`📂 Total Repositories`.padEnd(25) + `: ${chalk.green.bold(report.summary.totalRepositories)}`);
      console.log(`🔓 Public Repositories`.padEnd(25) + `: ${chalk.green.bold(report.summary.publicRepos)}`);
      console.log(`🔒 Private Repositories`.padEnd(25) + `: ${chalk.green.bold(report.summary.privateRepos)}`);
      console.log(`🏢 Organization Repos`.padEnd(25) + `: ${chalk.green.bold(report.summary.organizationRepos)}`);
      console.log(`👤 Personal Repos`.padEnd(25) + `: ${chalk.green.bold(report.summary.personalRepos)}`);
      console.log('─'.repeat(60));
    }

    console.log(chalk.blue.bold('\n📊 GitHub API Usage Summary:'));
    console.log(`Total API calls: ${this.apiCalls.length}`);
    const uniquePaths = [...new Set(this.apiCalls.map(call => call.url))];
    console.log(`API paths used: ${uniquePaths.join(', ')}`);
  }
}

// CLI Setup
const program = new Command();

program
  .name('associated-repos')
  .description('Query GitHub API to provide comprehensive list of associated repositories for users')
  .version('1.0.0');

program
  .option('--csvFile <path>', 'Path to CSV file containing users to analyze')
  .option('--searchUser <user>', 'Single user identifier to analyze (alternative to CSV)')
  .option('--org <org>', 'GitHub organization to filter repositories')
  .option('--repo <repo>', 'Comma-separated list of specific repository names')
  .option('--format <format>', 'Output format (json|csv)', 'json')
  .option('--outputDir <directory>', 'Directory to save files', './output')
  .option('--filename <filename>', 'Base name for output files')
  .option('--ignoreDateRange', 'Ignore date range filters', false)
  .option('--start <date>', 'Start date for analysis (YYYY-MM-DD)')
  .option('--end <date>', 'End date for analysis (YYYY-MM-DD)')
  .option('--token <token>', 'GitHub personal access token')
  .option('--verbose', 'Enable verbose logging', false)
  .option('--debug', 'Enable debug mode with audit files', false)
  .option('--loadData <filepath>', 'Path to JSON file to load at runtime')
  .option('--totalRecords <number>', 'Maximum total records to fetch (0 = no limit)', '0')
  .option('--delay <seconds>', 'Delay between API requests in seconds', '2')
  .option('--meta-tags <tags...>', 'Metadata tags in KEY=VALUE format')
  .action(async (options) => {
    try {
      // Validate required arguments
      if (!options.csvFile && !options.searchUser) {
        console.error(chalk.red('❌ Error: Either --csvFile or --searchUser is required'));
        process.exit(1);
      }

      // Set default dates if not provided and not ignored
      if (!options.ignoreDateRange) {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        
        options.start = options.start || thirtyDaysAgo.toISOString().split('T')[0];
        options.end = options.end || now.toISOString().split('T')[0];

        // Validate date format
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(options.start) || !dateRegex.test(options.end)) {
          console.error(chalk.red('❌ Dates must be in YYYY-MM-DD format'));
          process.exit(1);
        }
      }

      // Parse meta tags
      const metaTags = {};
      if (options.metaTags) {
        options.metaTags.forEach(tag => {
          const [key, value] = tag.split('=');
          if (key && value) {
            metaTags[key] = value;
          }
        });
      }

      // Parse totalRecords
      options.totalRecords = parseInt(options.totalRecords, 10);
      options.delay = parseFloat(options.delay);

      // Load additional data if specified
      let LOAD_DATA = null;
      if (options.loadData) {
        try {
          const loadDataContent = readFileSync(options.loadData, 'utf-8');
          LOAD_DATA = JSON.parse(loadDataContent);
        } catch (error) {
          console.error(chalk.red(`❌ Failed to load data file: ${error.message}`));
          process.exit(1);
        }
      }

      // Initialize analyzer
      const analyzer = new AssociatedRepos(options);
      analyzer.displaySummary(options);

      console.log(chalk.blue.bold('\n🚀 Starting GitHub repository analysis...'));

      // Get users to analyze
      let users = [];
      if (options.csvFile) {
        console.log(chalk.blue.bold('\n🔸 CSV File Processing'));
        if (!existsSync(options.csvFile)) {
          console.error(chalk.red(`❌ CSV file not found: ${options.csvFile}`));
          process.exit(1);
        }
        
        const csvUsers = analyzer.parseCsvFile(options.csvFile);
        console.log(chalk.green(`📁 Loaded ${csvUsers.length} users from CSV`));
        users = csvUsers.map(user => user.username || user.user || user.name).filter(Boolean);
      } else {
        users = [options.searchUser];
      }

      if (users.length === 0) {
        console.error(chalk.red('❌ No valid users found to analyze'));
        process.exit(1);
      }

      console.log(chalk.blue.bold('\n🔸 User Validation & Repository Analysis'));
      
      const analyzedUsers = [];
      
      await CLIProgressHelper.withProgress(
        users.length,
        'Analyzing users and their repositories',
        async (updateProgress) => {
          for (const username of users) {
            try {
              console.log(chalk.blue(`\n🔍 Analyzing user: ${username}`));
              
              // Validate user exists
              const userProfile = await analyzer.validateUser(username);
              console.log(chalk.green(`✅ User '${username}' validated`));

              // Get user repositories
              const repositories = await analyzer.getUserRepositories(username, options);
              
              // Calculate repository statistics
              const repositoryStats = {
                total: repositories.length,
                public: repositories.filter(repo => !repo.private).length,
                private: repositories.filter(repo => repo.private).length,
                byLanguage: {}
              };

              repositories.forEach(repo => {
                if (repo.language) {
                  repositoryStats.byLanguage[repo.language] = 
                    (repositoryStats.byLanguage[repo.language] || 0) + 1;
                }
              });

              analyzedUsers.push({
                username,
                profile: userProfile,
                repositories,
                repositoryStats
              });

              console.log(chalk.green(`📂 Found ${repositories.length} repositories for ${username}`));
              
            } catch (error) {
              console.error(chalk.red(`❌ Failed to analyze user ${username}: ${error.message}`));
            }
            
            updateProgress(1);
          }
        }
      );

      console.log(chalk.blue.bold('\n🔸 Report Generation'));
      
      const { filePath, report } = await analyzer.generateReport(analyzedUsers, {
        ...options,
        metaTags
      });

      console.log(chalk.green(`📄 Report saved: ${filePath}`));
      
      // Show final summary
      analyzer.displaySummary(options, report);
      await analyzer.showRateLimit();
      
      console.log(chalk.green.bold('\n✅ Analysis completed successfully!'));

    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      if (options.debug) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// Handle the case where the script is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}

export default AssociatedRepos;
