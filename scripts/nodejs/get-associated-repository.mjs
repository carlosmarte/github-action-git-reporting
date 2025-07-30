#!/usr/bin/env node

/**
 * Project: Associated Repositories Analyzer
 * Purpose: Analyze GitHub users from CSV input and discover all associated repositories (public/private)
 * Description: This tool reads a CSV file containing GitHub usernames and systematically discovers all repositories 
 *              associated with each user, including owned repos, contributed repos, and organizational memberships.
 *              Features real-time streaming to prevent data loss and comprehensive progress tracking.
 * 
 * Requirements Summary:
 * - Read users from CSV file (flexible column mapping)
 * - Discover all associated repositories for each user
 * - Stream results to file in real-time to prevent data loss
 * - Support both JSON and CSV output formats
 * - Handle rate limiting and API errors gracefully
 * - Provide detailed progress tracking and logging
 * 
 * JSON Report Structure Example:
 * {
 *   "inputs": { "csvFile": "users.csv", "format": "json", "totalUsers": 5 },
 *   "summary": { "totalUsers": 5, "totalRepositories": 847, "successfulAnalyses": 5, "failedAnalyses": 0 },
 *   "metaTags": {},
 *   "users": [
 *     {
 *       "user": "octocat",
 *       "userData": { "login": "octocat", "name": "The Octocat" },
 *       "repositories": {
 *         "owned": [{ "name": "Hello-World", "fullName": "octocat/Hello-World", "private": false }],
 *         "contributed": [],
 *         "organizations": []
 *       },
 *       "totals": { "ownedCount": 1, "contributedCount": 0, "organizationRepoCount": 0, "totalRepoCount": 1 }
 *     }
 *   ]
 * }
 * 
 * Potential Insights:
 * - Repository ownership patterns across team members
 * - Public vs private repository distributions
 * - Cross-organizational collaboration analysis
 * - Developer productivity and contribution patterns
 * - Security audit trail for repository access
 */

import { Command } from 'commander';
import { Octokit } from 'octokit';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, createWriteStream } from 'fs';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import dotenv from 'dotenv';
import { z } from 'zod';
import { API_Rate_Limiter } from '@thinkeloquent/npm-api-rate-limiter';
import { ProgressBar, CLIProgressHelper, Colors } from '@thinkeloquent/cli-progressor';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validation schemas
const UserSchema = z.object({
  username: z.string().optional(),
  user: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
}).refine(data => data.username || data.user || data.name, {
  message: "At least one of 'username', 'user', or 'name' must be provided"
});

const RepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  owner: z.object({
    login: z.string(),
    type: z.string(),
  }),
  html_url: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  pushed_at: z.string().nullable(),
  language: z.string().nullable(),
  stargazers_count: z.number(),
  watchers_count: z.number(),
  forks_count: z.number(),
});

/**
 * Streaming JSON Writer - handles real-time JSON streaming with proper array formatting
 */
class StreamingJsonWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.stream = null;
    this.isFirstItem = true;
    this.isOpen = false;
  }

  async open(metadata = {}) {
    this.stream = createWriteStream(this.filePath, { flags: 'w' });
    this.isOpen = true;
    
    // Write opening structure with metadata
    const opening = {
      ...metadata,
      users: []
    };
    
    const openingStr = JSON.stringify(opening, null, 2);
    // Remove the closing bracket and users array closing to prepare for streaming
    const modifiedOpening = openingStr.replace(/,\s*"users":\s*\[\s*\]\s*}$/, ',\n  "users": [');
    
    await this.writeToStream(modifiedOpening);
    this.isFirstItem = true;
  }

  async writeUser(userData) {
    if (!this.isOpen) throw new Error('StreamingJsonWriter not opened');
    
    const prefix = this.isFirstItem ? '\n    ' : ',\n    ';
    const userJson = JSON.stringify(userData, null, 4);
    // Indent the JSON properly for array formatting
    const indentedJson = userJson.replace(/\n/g, '\n    ');
    
    await this.writeToStream(prefix + indentedJson);
    this.isFirstItem = false;
  }

  async close() {
    if (!this.isOpen) return;
    
    // Close the users array and main object
    await this.writeToStream('\n  ]\n}');
    
    return new Promise((resolve, reject) => {
      this.stream.end((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  writeToStream(data) {
    return new Promise((resolve, reject) => {
      this.stream.write(data, 'utf8', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

/**
 * Streaming CSV Writer - handles real-time CSV streaming
 */
class StreamingCsvWriter {
  constructor(filePath, headers) {
    this.filePath = filePath;
    this.headers = headers;
    this.stream = null;
    this.csvStream = null;
    this.isOpen = false;
  }

  async open() {
    this.stream = createWriteStream(this.filePath, { flags: 'w' });
    this.csvStream = stringify({ 
      header: true, 
      columns: this.headers,
      quoted_string: true 
    });
    
    this.csvStream.pipe(this.stream);
    this.isOpen = true;
  }

  async writeRow(rowData) {
    if (!this.isOpen) throw new Error('StreamingCsvWriter not opened');
    
    return new Promise((resolve, reject) => {
      this.csvStream.write(rowData, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close() {
    if (!this.isOpen) return;
    
    return new Promise((resolve, reject) => {
      this.csvStream.end((error) => {
        this.stream.end(() => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
  }
}

/**
 * Progress Checkpoint Manager - handles resume capability
 */
class ProgressCheckpoint {
  constructor(checkpointFile) {
    this.checkpointFile = checkpointFile;
  }

  async save(progress) {
    const checkpoint = {
      timestamp: new Date().toISOString(),
      ...progress
    };
    await fs.promises.writeFile(this.checkpointFile, JSON.stringify(checkpoint, null, 2));
  }

  async load() {
    try {
      const data = await fs.promises.readFile(this.checkpointFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  async clear() {
    try {
      await fs.promises.unlink(this.checkpointFile);
    } catch (error) {
      // Ignore if file doesn't exist
    }
  }
}

class AssociatedRepositoriesAnalyzer {
  constructor(options = {}) {
    this.options = {
      ...options,
      token: options.token || process.env.GITHUB_TOKEN,
      baseURL: options.baseURL || process.env.GITHUB_BASE_API_URL || 'https://api.github.com',
      verbose: options.verbose || false,
      debug: options.debug || false,
    };

    if (!this.options.token) {
      throw new Error('GitHub token is required. Set GITHUB_TOKEN environment variable or use --token');
    }

    this.octokit = new Octokit({ 
      auth: this.options.token,
      baseUrl: this.options.baseURL
    });

    this.apiCallCount = 0;
    this.apiPaths = new Set();
    this.errors = [];
    this.auditData = [];

    // Rate limiters for different GitHub API endpoints
    this.coreLimiter = new API_Rate_Limiter("github-core-streaming", {
      getRateLimitStatus: () => this.getGitHubRateLimit("core")
    });

    this.searchLimiter = new API_Rate_Limiter("github-search-streaming", {
      getRateLimitStatus: () => this.getGitHubRateLimit("search")
    });

    // Global data loading
    if (this.options.loadData) {
      try {
        const loadedData = JSON.parse(fs.readFileSync(this.options.loadData, 'utf8'));
        this.LOAD_DATA = loadedData;
        if (this.options.verbose) {
          console.log(chalk.blue(`📂 Loaded data from ${this.options.loadData}`));
        }
      } catch (error) {
        console.warn(chalk.yellow(`⚠️  Warning: Could not load data from ${this.options.loadData}: ${error.message}`));
        this.LOAD_DATA = {};
      }
    } else {
      this.LOAD_DATA = {};
    }

    // Setup logging
    if (this.options.verbose || this.options.debug) {
      this.logFile = path.join(this.options.outputDir || './output', 'github.log');
      this.initializeLogging();
    }
  }

  initializeLogging() {
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Clear previous log
    fs.writeFileSync(this.logFile, `=== GitHub API Log - ${new Date().toISOString()} ===\n`);
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    
    if (this.options.verbose || this.options.debug) {
      fs.appendFileSync(this.logFile, logMessage);
    }
    
    if (this.options.verbose && level !== 'debug') {
      console.log(chalk.gray(`🔍 ${message}`));
    }
  }

  async getGitHubRateLimit(resource = "core") {
    try {
      const response = await this.octokit.rest.rateLimit.get();
      return response.data.resources[resource];
    } catch (error) {
      this.log(`Failed to fetch rate limit for ${resource}: ${error.message}`, 'error');
      return { remaining: 1, reset: Math.floor(Date.now() / 1000) + 60 };
    }
  }

  async makeRequest(url, options = {}) {
    this.apiCallCount++;
    const apiPath = url.replace(this.options.baseURL, '');
    this.apiPaths.add(apiPath);
    
    this.log(`API Request: ${apiPath}`, 'debug');
    
    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `token ${this.options.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'AssociatedRepositoriesAnalyzer/1.0',
          ...options.headers
        },
        ...options
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (this.options.debug) {
        this.auditData.push({
          timestamp: new Date().toISOString(),
          url,
          status: response.status,
          data
        });
      }

      this.log(`API Response: ${apiPath} - Status: ${response.status}`, 'debug');
      return data;
    } catch (error) {
      this.log(`API Error: ${apiPath} - ${error.message}`, 'error');
      this.errors.push({ url, error: error.message, timestamp: new Date().toISOString() });
      throw error;
    }
  }

  async validateUser(username) {
    return this.coreLimiter.schedule(async () => {
      try {
        const user = await this.makeRequest(`${this.options.baseURL}/users/${username}`);
        this.log(`User validated: ${username}`);
        return user;
      } catch (error) {
        this.log(`User validation failed for ${username}: ${error.message}`, 'error');
        throw error;
      }
    });
  }

  async getUserRepositories(username) {
    const repositories = {
      owned: [],
      contributed: [],
      organizations: []
    };

    // Fetch owned repositories
    await this.coreLimiter.schedule(async () => {
      try {
        let page = 1;
        let hasMore = true;
        
        while (hasMore) {
          const repos = await this.makeRequest(
            `${this.options.baseURL}/users/${username}/repos?per_page=100&page=${page}&type=all&sort=updated`
          );
          
          if (repos.length === 0) {
            hasMore = false;
          } else {
            repositories.owned.push(...repos.map(repo => this.formatRepository(repo)));
            page++;
            
            if (this.options.totalRecords > 0 && repositories.owned.length >= this.options.totalRecords) {
              repositories.owned = repositories.owned.slice(0, this.options.totalRecords);
              hasMore = false;
            }
          }
        }
        
        this.log(`Found ${repositories.owned.length} owned repositories for ${username}`);
      } catch (error) {
        this.log(`Failed to fetch owned repositories for ${username}: ${error.message}`, 'error');
      }
    });

    // Fetch organizations and their repositories
    await this.coreLimiter.schedule(async () => {
      try {
        const orgs = await this.makeRequest(`${this.options.baseURL}/users/${username}/orgs`);
        
        for (const org of orgs) {
          try {
            let page = 1;
            let hasMore = true;
            
            while (hasMore) {
              const orgRepos = await this.makeRequest(
                `${this.options.baseURL}/orgs/${org.login}/repos?per_page=100&page=${page}&type=all`
              );
              
              if (orgRepos.length === 0) {
                hasMore = false;
              } else {
                repositories.organizations.push(...orgRepos.map(repo => ({
                  ...this.formatRepository(repo),
                  organization: org.login
                })));
                page++;
                
                if (this.options.totalRecords > 0 && repositories.organizations.length >= this.options.totalRecords) {
                  repositories.organizations = repositories.organizations.slice(0, this.options.totalRecords);
                  hasMore = false;
                  break;
                }
              }
            }
          } catch (error) {
            this.log(`Failed to fetch repositories for org ${org.login}: ${error.message}`, 'error');
          }
        }
        
        this.log(`Found ${repositories.organizations.length} organization repositories for ${username}`);
      } catch (error) {
        this.log(`Failed to fetch organizations for ${username}: ${error.message}`, 'error');
      }
    });

    return repositories;
  }

  formatRepository(repo) {
    try {
      const validated = RepositorySchema.parse(repo);
      
      return {
        id: validated.id,
        name: validated.name,
        fullName: validated.full_name,
        private: validated.private,
        owner: validated.owner.login,
        ownerType: validated.owner.type,
        htmlUrl: validated.html_url,
        description: validated.description,
        language: validated.language,
        stars: validated.stargazers_count,
        watchers: validated.watchers_count,
        forks: validated.forks_count,
        createdAt: validated.created_at,
        updatedAt: validated.updated_at,
        pushedAt: validated.pushed_at
      };
    } catch (error) {
      this.log(`Repository validation failed: ${error.message}`, 'error');
      // Return minimal data if validation fails
      return {
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private || false,
        owner: repo.owner?.login || 'unknown',
        ownerType: repo.owner?.type || 'unknown'
      };
    }
  }

  async readCsvFile(csvFile) {
    const users = [];
    
    return new Promise((resolve, reject) => {
      createReadStream(csvFile)
        .pipe(parse({ 
          columns: true, 
          skip_empty_lines: true,
          delimiter: ',',
          trim: true 
        }))
        .on('data', (row) => {
          try {
            // Flexible mapping - look for username in various column names
            const username = row.username || row.user || row.name || row.login || row.github_username;
            
            if (username) {
              const validatedUser = UserSchema.parse({
                username: username,
                user: row.user,
                name: row.name || row.display_name,
                email: row.email
              });
              
              // Include all additional CSV columns as metadata
              const userData = {
                username: username,
                csvData: row
              };
              
              users.push(userData);
            }
          } catch (error) {
            this.log(`Invalid user data in CSV row: ${JSON.stringify(row)} - ${error.message}`, 'error');
          }
        })
        .on('end', () => {
          this.log(`Successfully read ${users.length} users from CSV file`);
          resolve(users);
        })
        .on('error', (error) => {
          this.log(`Failed to read CSV file: ${error.message}`, 'error');
          reject(error);
        });
    });
  }

  async analyze(csvFile, options = {}) {
    console.log(chalk.blue.bold('🔸 Initialization'));
    console.log(chalk.green.bold('🔧 AssociatedRepositoriesAnalyzer initialized'));

    // Display configuration
    const config = [
      ['📊 Rate limit', 'Dynamic'],
      ['📁 CSV file', csvFile],
      ['📅 Date range', options.ignoreDateRange ? 'Ignored' : `${options.start} to ${options.end}`],
      ['🏢 Organization', options.org || 'All organizations'],
      ['📂 Repositories', options.repo || 'All repositories'],
      ['📄 Output format', options.format || 'JSON'],
      ['💾 Output directory', options.outputDir || './output'],
      ['🔍 Verbose mode', options.verbose ? 'Enabled' : 'Disabled'],
      ['🐛 Debug mode', options.debug ? 'Enabled' : 'Disabled'],
      ['📊 Total records limit', options.totalRecords || 'No limit'],
      ['⏱️  API delay', `${options.delay || 6} seconds`],
      ['🔄 Streaming', 'Enabled (real-time file writing)']
    ];

    console.log('\nParameter            Value');
    console.log('─'.repeat(50));
    config.forEach(([param, value]) => {
      console.log(`${param.padEnd(20)} ${value}`);
    });

    console.log(chalk.blue.bold('\n🚀 Starting CSV-based repository analysis...'));

    // Setup output directory
    const outputDir = options.outputDir || './output';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Setup checkpoint management
    const checkpointFile = path.join(outputDir, '.checkpoint.json');
    const checkpoint = new ProgressCheckpoint(checkpointFile);

    // Read users from CSV
    console.log(chalk.blue.bold('\n🔸 CSV Processing'));
    const users = await this.readCsvFile(csvFile);
    console.log(chalk.green(`📊 Loaded ${users.length} users from CSV`));

    if (users.length === 0) {
      throw new Error('No valid users found in CSV file');
    }

    // Check for resume capability
    const existingProgress = await checkpoint.load();
    let startIndex = 0;
    
    if (existingProgress && existingProgress.processedUsers) {
      console.log(chalk.yellow(`🔄 Found previous progress: ${existingProgress.processedUsers} users processed`));
      startIndex = existingProgress.processedUsers;
    }

    // Setup file paths
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseFilename = options.filename || `associated-repositories-${timestamp}`;
    const outputFile = path.join(outputDir, `${baseFilename}.${options.format || 'json'}`);
    const auditFile = path.join(outputDir, `${baseFilename}.audit.json`);

    // Initialize streaming writers
    let writer;
    const format = options.format || 'json';
    
    if (format === 'json') {
      writer = new StreamingJsonWriter(outputFile);
      await writer.open({
        inputs: {
          csvFile: path.basename(csvFile),
          format: format,
          totalUsers: users.length,
          outputDir: outputDir,
          generatedAt: new Date().toISOString(),
          ...options
        },
        metaTags: this.parseMetaTags(options.metaTags || []),
        summary: {
          totalUsers: users.length,
          processedUsers: 0,
          totalRepositories: 0,
          successfulAnalyses: 0,
          failedAnalyses: 0
        }
      });
    } else {
      const csvHeaders = [
        'username', 'user_name', 'user_email', 'user_company', 'user_type',
        'repo_name', 'repo_full_name', 'repo_private', 'repo_owner', 'repo_type',
        'repo_language', 'repo_stars', 'repo_forks', 'repo_created_at',
        'organization', 'association_type'
      ];
      writer = new StreamingCsvWriter(outputFile, csvHeaders);
      await writer.open();
    }

    // Process users with streaming
    console.log(chalk.blue.bold('\n🔸 Repository Analysis'));
    
    let processedUsers = startIndex;
    let totalRepositories = 0;
    let successfulAnalyses = 0;
    let failedAnalyses = 0;

    const remainingUsers = users.slice(startIndex);
    
    await CLIProgressHelper.withProgress(
      remainingUsers.length,
      'Analyzing user repositories',
      async (updateProgress) => {
        for (const [index, userData] of remainingUsers.entries()) {
          const username = userData.username;
          
          try {
            this.log(`Processing user: ${username}`);
            
            // Validate user exists
            const githubUser = await this.validateUser(username);
            
            // Get all associated repositories
            const repositories = await this.getUserRepositories(username);
            
            // Calculate totals
            const totals = {
              ownedCount: repositories.owned.length,
              contributedCount: repositories.contributed.length,
              organizationRepoCount: repositories.organizations.length,
              totalRepoCount: repositories.owned.length + repositories.contributed.length + repositories.organizations.length
            };
            
            totalRepositories += totals.totalRepoCount;

            const userResult = {
              user: username,
              userData: {
                login: githubUser.login,
                id: githubUser.id,
                name: githubUser.name,
                email: githubUser.email,
                company: githubUser.company,
                location: githubUser.location,
                bio: githubUser.bio,
                publicRepos: githubUser.public_repos,
                followers: githubUser.followers,
                following: githubUser.following,
                createdAt: githubUser.created_at,
                updatedAt: githubUser.updated_at
              },
              csvData: userData.csvData,
              repositories,
              totals,
              processedAt: new Date().toISOString()
            };

            // Stream to file immediately
            if (format === 'json') {
              await writer.writeUser(userResult);
            } else {
              // Write multiple CSV rows for each repository
              const writeRepoRows = async (repos, associationType) => {
                for (const repo of repos) {
                  await writer.writeRow({
                    username: username,
                    user_name: githubUser.name || '',
                    user_email: githubUser.email || '',
                    user_company: githubUser.company || '',
                    user_type: githubUser.type || '',
                    repo_name: repo.name,
                    repo_full_name: repo.fullName,
                    repo_private: repo.private,
                    repo_owner: repo.owner,
                    repo_type: repo.ownerType,
                    repo_language: repo.language || '',
                    repo_stars: repo.stars || 0,
                    repo_forks: repo.forks || 0,
                    repo_created_at: repo.createdAt || '',
                    organization: repo.organization || '',
                    association_type: associationType
                  });
                }
              };

              await writeRepoRows(repositories.owned, 'owned');
              await writeRepoRows(repositories.contributed, 'contributed');
              await writeRepoRows(repositories.organizations, 'organization');
            }

            successfulAnalyses++;
            processedUsers++;
            
            // Save checkpoint
            await checkpoint.save({
              processedUsers,
              successfulAnalyses,
              failedAnalyses,
              totalRepositories
            });

            this.log(`Successfully processed ${username}: ${totals.totalRepoCount} repositories`);
            
          } catch (error) {
            this.log(`Failed to process user ${username}: ${error.message}`, 'error');
            failedAnalyses++;
            processedUsers++;
            
            // Stream error record
            if (format === 'json') {
              await writer.writeUser({
                user: username,
                error: error.message,
                processedAt: new Date().toISOString(),
                csvData: userData.csvData
              });
            }
          }
          
          updateProgress(1);
          
          // Respect delay between users
          if (options.delay && index < remainingUsers.length - 1) {
            await new Promise(resolve => setTimeout(resolve, options.delay * 1000));
          }
        }
      }
    );

    // Close streaming writer
    await writer.close();

    // Clean up checkpoint on successful completion
    await checkpoint.clear();

    console.log(chalk.blue.bold('\n📊 Processing Summary'));
    console.log('─'.repeat(50));
    console.log(`✅ Successfully processed  : ${successfulAnalyses} users`);
    console.log(`❌ Failed to process       : ${failedAnalyses} users`);
    console.log(`📊 Total users            : ${users.length} users`);
    console.log(`📂 Total repositories     : ${totalRepositories} repos`);
    console.log(`📈 Success rate           : ${((successfulAnalyses / users.length) * 100).toFixed(1)}%`);
    console.log('─'.repeat(50));

    // Generate audit file if debug mode
    if (options.debug && this.auditData.length > 0) {
      const auditData = {
        generatedAt: new Date().toISOString(),
        totalApiCalls: this.apiCallCount,
        apiPaths: Array.from(this.apiPaths),
        errors: this.errors,
        requests: this.auditData
      };
      
      await fs.promises.writeFile(auditFile, JSON.stringify(auditData, null, 2));
      console.log(chalk.blue(`📄 Debug audit saved: ${auditFile}`));
    }

    // Final report generation
    console.log(chalk.blue.bold('\n🔸 Report Generation'));
    console.log(chalk.green(`📄 Report saved: ${outputFile}`));

    // Show API usage summary
    await this.showApiUsageSummary();
    await this.showRateLimit();

    console.log(chalk.green.bold('\n✅ Analysis completed successfully!'));

    // Final summary
    console.log(chalk.blue.bold('\n📊 Final Report Summary'));
    console.log('─'.repeat(60));
    console.log(`📊 Total Users Processed  : ${processedUsers}`);
    console.log(`📂 Total Repositories     : ${totalRepositories}`);
    console.log(`✅ Successful Analyses    : ${successfulAnalyses}`);
    console.log(`❌ Failed Analyses        : ${failedAnalyses}`);
    console.log(`📄 Report Location        : ${outputFile}`);
    if (options.debug) {
      console.log(`🔍 Audit File Location    : ${auditFile}`);
    }
    console.log('─'.repeat(60));

    return {
      totalUsers: users.length,
      processedUsers,
      totalRepositories,
      successfulAnalyses,
      failedAnalyses,
      outputFile,
      auditFile: options.debug ? auditFile : null
    };
  }

  parseMetaTags(metaTags) {
    const tags = {};
    if (Array.isArray(metaTags)) {
      metaTags.forEach(tag => {
        const [key, value] = tag.split('=');
        if (key && value) {
          tags[key.trim()] = value.trim();
        }
      });
    }
    return tags;
  }

  async showApiUsageSummary() {
    console.log(chalk.blue.bold('\n📊 GitHub API Usage Summary:'));
    console.log('─'.repeat(60));
    console.log(`Total API calls: ${this.apiCallCount}`);
    console.log(`API paths used: ${Array.from(this.apiPaths).join(', ')}`);
  }

  async showRateLimit() {
    try {
      const data = await this.makeRequest(`${this.options.baseURL}/rate_limit`);
      const { rate } = data;

      console.log(chalk.blue.bold("\n📊 GitHub API Rate Limit Status:"));
      console.log(`   Limit: ${chalk.green.bold(rate.limit)}`);
      console.log(`   Remaining: ${chalk.green.bold(rate.remaining)}`);
      console.log(`   Used: ${chalk.yellow.bold(rate.used)}`);
      console.log(
        `   Resets at: ${chalk.gray(new Date(rate.reset * 1000).toLocaleString())}`
      );

      if (rate.remaining < 10) {
        console.log(chalk.red.bold("   ⚠️  Warning: Rate limit is low!"));
      }
    } catch (error) {
      console.error(chalk.red("❌ Failed to fetch rate limit information"));
    }
  }
}

// CLI Setup
const program = new Command();

program
  .name('associated-repositories-analyzer')
  .description('Analyze GitHub users from CSV and discover all associated repositories')
  .version('1.0.0')
  .requiredOption('--csvFile <file>', 'Path to CSV file containing users to analyze')
  .option('--org <org>', 'GitHub organization to filter repositories')
  .option('--repo <repo>', 'Comma-separated list of specific repository names')
  .option('--meta-tags <tags...>', 'Metadata tags in KEY=VALUE format', [])
  .option('--format <format>', 'Output format (json|csv)', 'json')
  .option('--outputDir <directory>', 'Directory to save files', './output')
  .option('--filename <filename>', 'Base name for output files')
  .option('--ignoreDateRange', 'Ignore date range filtering', false)
  .option('--start <date>', 'Start date (YYYY-MM-DD)')
  .option('--end <date>', 'End date (YYYY-MM-DD)')
  .option('--token <token>', 'GitHub personal access token')
  .option('--verbose', 'Enable verbose logging', false)
  .option('--debug', 'Enable debug logging with audit files', false)
  .option('--loadData <filepath>', 'Path to JSON file to load at runtime')
  .option('--totalRecords <number>', 'Maximum number of records to fetch (0 = no limit)', '0')
  .option('--delay <seconds>', 'Delay between API requests in seconds', '6');

program.action(async (options) => {
  try {
    // Validate required CSV file
    if (!fs.existsSync(options.csvFile)) {
      throw new Error(`CSV file not found: ${options.csvFile}`);
    }

    // Set default dates if not provided and not ignoring date range
    if (!options.ignoreDateRange) {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
      
      options.start = options.start || thirtyDaysAgo.toISOString().split('T')[0];
      options.end = options.end || now.toISOString().split('T')[0];

      // Validate date format
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(options.start) || !dateRegex.test(options.end)) {
        throw new Error('Dates must be in YYYY-MM-DD format');
      }
    }

    // Convert totalRecords to number
    options.totalRecords = parseInt(options.totalRecords, 10);
    options.delay = parseFloat(options.delay);

    const analyzer = new AssociatedRepositoriesAnalyzer(options);
    await analyzer.analyze(options.csvFile, options);

  } catch (error) {
    console.error(chalk.red(`❌ Error: ${error.message}`));
    process.exit(1);
  }
});

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n🛑 Process interrupted. Progress has been saved to checkpoint file.'));
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n🛑 Process terminated. Progress has been saved to checkpoint file.'));
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}

export default AssociatedRepositoriesAnalyzer;
