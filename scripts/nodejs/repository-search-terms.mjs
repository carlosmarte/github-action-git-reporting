#!/usr/bin/env node

/**
 * Project: GitHub Repository Search Terms Analyzer
 * Purpose: Search GitHub repositories for specific terms across pull requests, issues, commits, and codebase
 * Description: This tool searches through GitHub repositories for user-specified terms across multiple content types
 *              (pull requests, issues, commits, and code). Features real-time streaming to prevent data loss,
 *              comprehensive progress tracking, and support for multiple search terms and repository identification methods.
 * 
 * Requirements Summary:
 * - Stream response data to output file in real-time to prevent data loss
 * - Search pull requests, issues, commits, and codebase for specific terms
 * - Support multiple search terms via repeated --contains arguments
 * - Support repository identification by name, ID, or node_id
 * - Handle rate limiting and API errors gracefully
 * - Provide detailed progress tracking and logging
 * 
 * JSON Report Structure Example:
 * {
 *   "inputs": { "searchTerms": ["bug", "fix"], "repositories": ["octocat/Hello-World"], "contentTypes": ["pulls", "issues", "commits", "code"] },
 *   "summary": { "totalSearches": 8, "totalResults": 45, "successfulSearches": 8, "failedSearches": 0 },
 *   "metaTags": { "project": "security-audit" },
 *   "searches": [
 *     {
 *       "term": "bug",
 *       "repository": "octocat/Hello-World",
 *       "contentType": "issues",
 *       "results": [{ "number": 1347, "title": "Bug in user authentication", "url": "https://github.com/octocat/Hello-World/issues/1347" }],
 *       "totalResults": 12,
 *       "searchedAt": "2024-12-26T10:30:00.000Z"
 *     }
 *   ]
 * }
 * 
 * Potential Insights:
 * - Term frequency analysis across different content types
 * - Repository security and bug patterns
 * - Code quality and documentation gaps
 * - Issue and pull request trending topics
 * - Cross-repository term distribution analysis
 */

import { Command } from 'commander';
import { Octokit } from 'octokit';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import dotenv from 'dotenv';
import { z } from 'zod';
import { expect } from 'expect';
import { API_Rate_Limiter } from '@thinkeloquent/npm-api-rate-limiter';
import { ProgressBar, CLIProgressHelper, Colors } from '@thinkeloquent/cli-progressor';
import { stringify } from 'csv-stringify';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validation schemas
const RepositorySchema = z.object({
  id: z.number(),
  node_id: z.string(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  owner: z.object({
    login: z.string(),
    id: z.number(),
    type: z.string(),
  }),
  html_url: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const SearchResultSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(z.any()),
});

const IssueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  user: z.object({
    login: z.string(),
    id: z.number(),
  }),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const CommitSchema = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    author: z.object({
      name: z.string(),
      email: z.string(),
      date: z.string(),
    }),
  }),
  html_url: z.string(),
  author: z.object({
    login: z.string(),
    id: z.number(),
  }).nullable(),
});

const CodeSearchSchema = z.object({
  name: z.string(),
  path: z.string(),
  sha: z.string(),
  html_url: z.string(),
  repository: z.object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
  }),
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
      searches: []
    };
    
    const openingStr = JSON.stringify(opening, null, 2);
    // Remove the closing bracket and searches array closing to prepare for streaming
    const modifiedOpening = openingStr.replace(/,\s*"searches":\s*\[\s*\]\s*}$/, ',\n  "searches": [');
    
    await this.writeToStream(modifiedOpening);
    this.isFirstItem = true;
  }

  async writeSearch(searchData) {
    if (!this.isOpen) throw new Error('StreamingJsonWriter not opened');
    
    const prefix = this.isFirstItem ? '\n    ' : ',\n    ';
    const searchJson = JSON.stringify(searchData, null, 4);
    // Indent the JSON properly for array formatting
    const indentedJson = searchJson.replace(/\n/g, '\n    ');
    
    await this.writeToStream(prefix + indentedJson);
    this.isFirstItem = false;
  }

  async close() {
    if (!this.isOpen) return;
    
    // Close the searches array and main object
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
 * Progress Checkpoint Manager - handles resume capability and prevents data loss
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

class GithubRepoSearchTerms {
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
    this.coreLimiter = new API_Rate_Limiter("github-core-search-terms", {
      getRateLimitStatus: () => this.getGitHubRateLimit("core")
    });

    this.searchLimiter = new API_Rate_Limiter("github-search-search-terms", {
      getRateLimitStatus: () => this.getGitHubRateLimit("search")
    });

    this.codeSearchLimiter = new API_Rate_Limiter("github-code-search-terms", {
      getRateLimitStatus: () => this.getGitHubRateLimit("code_search")
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
    fs.writeFileSync(this.logFile, `=== GitHub Search Terms Log - ${new Date().toISOString()} ===\n`);
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
          'User-Agent': 'GithubRepoSearchTerms/1.0',
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

  async validateRepository(repoIdentifier) {
    return this.coreLimiter.schedule(async () => {
      try {
        let repo;
        
        // Try different ways to identify the repository
        if (repoIdentifier.includes('/')) {
          // Assume it's owner/repo format
          repo = await this.makeRequest(`${this.options.baseURL}/repos/${repoIdentifier}`);
        } else if (repoIdentifier.match(/^\d+$/)) {
          // It's a numeric ID
          const repos = await this.makeRequest(`${this.options.baseURL}/repositories/${repoIdentifier}`);
          repo = repos;
        } else {
          // Assume it's a node_id or repo name, try to search
          const searchResponse = await this.makeRequest(
            `${this.options.baseURL}/search/repositories?q=${encodeURIComponent(repoIdentifier)}&per_page=1`
          );
          if (searchResponse.items && searchResponse.items.length > 0) {
            repo = searchResponse.items[0];
          } else {
            throw new Error(`Repository not found: ${repoIdentifier}`);
          }
        }
        
        const validated = RepositorySchema.parse(repo);
        this.log(`Repository validated: ${validated.full_name}`);
        return validated;
      } catch (error) {
        this.log(`Repository validation failed for ${repoIdentifier}: ${error.message}`, 'error');
        throw error;
      }
    });
  }

  async searchPullRequests(repo, term, dateRange = null) {
    const results = [];
    let query = `${term} repo:${repo.full_name} is:pr`;
    
    if (dateRange && !this.options.ignoreDateRange) {
      query += ` created:${dateRange.start}..${dateRange.end}`;
    }

    return this.searchLimiter.schedule(async () => {
      try {
        let page = 1;
        let hasMore = true;
        let totalFetched = 0;
        
        this.log(`Searching pull requests in ${repo.full_name} for term: ${term}`);
        
        while (hasMore && (this.options.totalRecords === 0 || totalFetched < this.options.totalRecords)) {
          const response = await this.makeRequest(
            `${this.options.baseURL}/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}&sort=created&order=desc`
          );
          
          const searchResult = SearchResultSchema.parse(response);
          
          if (searchResult.items.length === 0) {
            hasMore = false;
          } else {
            const pullRequests = searchResult.items.map(item => {
              try {
                const validated = IssueSchema.parse(item);
                return {
                  id: validated.id,
                  number: validated.number,
                  title: validated.title,
                  body: validated.body,
                  state: validated.state,
                  author: validated.user.login,
                  url: validated.html_url,
                  createdAt: validated.created_at,
                  updatedAt: validated.updated_at,
                  contentType: 'pull_request'
                };
              } catch (error) {
                this.log(`Pull request validation failed: ${error.message}`, 'error');
                return null;
              }
            }).filter(pr => pr !== null);
            
            results.push(...pullRequests);
            totalFetched += pullRequests.length;
            page++;
            
            if (this.options.totalRecords > 0 && totalFetched >= this.options.totalRecords) {
              hasMore = false;
            }
            
            if (page > 10) { // GitHub search API has a 1000 result limit (10 pages * 100)
              hasMore = false;
            }
          }
        }
        
        this.log(`Found ${results.length} pull requests for term "${term}" in ${repo.full_name}`);
        return results;
      } catch (error) {
        this.log(`Failed to search pull requests for ${term} in ${repo.full_name}: ${error.message}`, 'error');
        throw error;
      }
    });
  }

  async searchIssues(repo, term, dateRange = null) {
    const results = [];
    let query = `${term} repo:${repo.full_name} is:issue`;
    
    if (dateRange && !this.options.ignoreDateRange) {
      query += ` created:${dateRange.start}..${dateRange.end}`;
    }

    return this.searchLimiter.schedule(async () => {
      try {
        let page = 1;
        let hasMore = true;
        let totalFetched = 0;
        
        this.log(`Searching issues in ${repo.full_name} for term: ${term}`);
        
        while (hasMore && (this.options.totalRecords === 0 || totalFetched < this.options.totalRecords)) {
          const response = await this.makeRequest(
            `${this.options.baseURL}/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}&sort=created&order=desc`
          );
          
          const searchResult = SearchResultSchema.parse(response);
          
          if (searchResult.items.length === 0) {
            hasMore = false;
          } else {
            const issues = searchResult.items.map(item => {
              try {
                const validated = IssueSchema.parse(item);
                return {
                  id: validated.id,
                  number: validated.number,
                  title: validated.title,
                  body: validated.body,
                  state: validated.state,
                  author: validated.user.login,
                  url: validated.html_url,
                  createdAt: validated.created_at,
                  updatedAt: validated.updated_at,
                  contentType: 'issue'
                };
              } catch (error) {
                this.log(`Issue validation failed: ${error.message}`, 'error');
                return null;
              }
            }).filter(issue => issue !== null);
            
            results.push(...issues);
            totalFetched += issues.length;
            page++;
            
            if (this.options.totalRecords > 0 && totalFetched >= this.options.totalRecords) {
              hasMore = false;
            }
            
            if (page > 10) { // GitHub search API has a 1000 result limit
              hasMore = false;
            }
          }
        }
        
        this.log(`Found ${results.length} issues for term "${term}" in ${repo.full_name}`);
        return results;
      } catch (error) {
        this.log(`Failed to search issues for ${term} in ${repo.full_name}: ${error.message}`, 'error');
        throw error;
      }
    });
  }

  async searchCommits(repo, term, dateRange = null) {
    const results = [];
    let query = `${term} repo:${repo.full_name}`;
    
    if (dateRange && !this.options.ignoreDateRange) {
      query += ` committer-date:${dateRange.start}..${dateRange.end}`;
    }

    return this.searchLimiter.schedule(async () => {
      try {
        let page = 1;
        let hasMore = true;
        let totalFetched = 0;
        
        this.log(`Searching commits in ${repo.full_name} for term: ${term}`);
        
        while (hasMore && (this.options.totalRecords === 0 || totalFetched < this.options.totalRecords)) {
          const response = await this.makeRequest(
            `${this.options.baseURL}/search/commits?q=${encodeURIComponent(query)}&per_page=100&page=${page}&sort=committer-date&order=desc`
          );
          
          const searchResult = SearchResultSchema.parse(response);
          
          if (searchResult.items.length === 0) {
            hasMore = false;
          } else {
            const commits = searchResult.items.map(item => {
              try {
                const validated = CommitSchema.parse(item);
                return {
                  sha: validated.sha,
                  message: validated.commit.message,
                  author: {
                    name: validated.commit.author.name,
                    email: validated.commit.author.email,
                    login: validated.author?.login || null
                  },
                  date: validated.commit.author.date,
                  url: validated.html_url,
                  contentType: 'commit'
                };
              } catch (error) {
                this.log(`Commit validation failed: ${error.message}`, 'error');
                return null;
              }
            }).filter(commit => commit !== null);
            
            results.push(...commits);
            totalFetched += commits.length;
            page++;
            
            if (this.options.totalRecords > 0 && totalFetched >= this.options.totalRecords) {
              hasMore = false;
            }
            
            if (page > 10) { // GitHub search API has a 1000 result limit
              hasMore = false;
            }
          }
        }
        
        this.log(`Found ${results.length} commits for term "${term}" in ${repo.full_name}`);
        return results;
      } catch (error) {
        this.log(`Failed to search commits for ${term} in ${repo.full_name}: ${error.message}`, 'error');
        throw error;
      }
    });
  }

  async searchCode(repo, term) {
    const results = [];
    const query = `${term} repo:${repo.full_name}`;

    return this.codeSearchLimiter.schedule(async () => {
      try {
        let page = 1;
        let hasMore = true;
        let totalFetched = 0;
        
        this.log(`Searching code in ${repo.full_name} for term: ${term}`);
        
        while (hasMore && (this.options.totalRecords === 0 || totalFetched < this.options.totalRecords)) {
          const response = await this.makeRequest(
            `${this.options.baseURL}/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`
          );
          
          const searchResult = SearchResultSchema.parse(response);
          
          if (searchResult.items.length === 0) {
            hasMore = false;
          } else {
            const codeResults = searchResult.items.map(item => {
              try {
                const validated = CodeSearchSchema.parse(item);
                return {
                  name: validated.name,
                  path: validated.path,
                  sha: validated.sha,
                  url: validated.html_url,
                  repository: {
                    id: validated.repository.id,
                    name: validated.repository.name,
                    fullName: validated.repository.full_name
                  },
                  contentType: 'code'
                };
              } catch (error) {
                this.log(`Code search result validation failed: ${error.message}`, 'error');
                return null;
              }
            }).filter(code => code !== null);
            
            results.push(...codeResults);
            totalFetched += codeResults.length;
            page++;
            
            if (this.options.totalRecords > 0 && totalFetched >= this.options.totalRecords) {
              hasMore = false;
            }
            
            if (page > 10) { // GitHub search API has a 1000 result limit
              hasMore = false;
            }
          }
          
          // Code search has stricter rate limits, add extra delay
          if (this.options.delay && hasMore) {
            await new Promise(resolve => setTimeout(resolve, this.options.delay * 1000));
          }
        }
        
        this.log(`Found ${results.length} code results for term "${term}" in ${repo.full_name}`);
        return results;
      } catch (error) {
        this.log(`Failed to search code for ${term} in ${repo.full_name}: ${error.message}`, 'error');
        throw error;
      }
    });
  }

  async analyze(options = {}) {
    console.log(chalk.blue.bold('🔸 Initialization'));
    console.log(chalk.green.bold('🔧 GithubRepoSearchTerms initialized'));

    // Validate required options
    if (!options.contains || options.contains.length === 0) {
      throw new Error('At least one search term must be provided via --contains');
    }

    if (!options.repo && !options.org && !options.searchUser) {
      throw new Error('Repository must be specified via --repo, --org, or --searchUser');
    }

    // Setup date range
    let dateRange = null;
    if (!options.ignoreDateRange) {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
      
      dateRange = {
        start: options.start || thirtyDaysAgo.toISOString().split('T')[0],
        end: options.end || now.toISOString().split('T')[0]
      };

      // Validate date format
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(dateRange.start) || !dateRegex.test(dateRange.end)) {
        throw new Error('Dates must be in YYYY-MM-DD format');
      }
    }

    // Display configuration
    const config = [
      ['📊 Rate limit', 'Dynamic'],
      ['🔍 Search terms', options.contains.join(', ')],
      ['📅 Date range', options.ignoreDateRange ? 'Ignored' : `${dateRange.start} to ${dateRange.end}`],
      ['🏢 Organization', options.org || 'Not specified'],
      ['📂 Repository', options.repo || 'Auto-discover from user'],
      ['👤 Search user', options.searchUser || 'Not specified'],
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

    console.log(chalk.blue.bold('\n🚀 Starting GitHub repository search terms analysis...'));

    // Setup output directory
    const outputDir = options.outputDir || './output';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Setup checkpoint management
    const checkpointFile = path.join(outputDir, '.checkpoint.json');
    const checkpoint = new ProgressCheckpoint(checkpointFile);

    // Determine repositories to search
    let repositories = [];
    
    if (options.repo) {
      // Parse comma-separated repository identifiers
      const repoIdentifiers = options.repo.split(',').map(r => r.trim());
      
      console.log(chalk.blue.bold('\n🔸 Repository Validation'));
      
      await CLIProgressHelper.withProgress(
        repoIdentifiers.length,
        'Validating repositories',
        async (updateProgress) => {
          for (const identifier of repoIdentifiers) {
            try {
              const repo = await this.validateRepository(identifier);
              repositories.push(repo);
              this.log(`Repository validated: ${repo.full_name}`);
            } catch (error) {
              this.log(`Failed to validate repository ${identifier}: ${error.message}`, 'error');
            }
            updateProgress(1);
          }
        }
      );
    } else if (options.searchUser) {
      // Auto-discover repositories from user
      console.log(chalk.blue.bold('\n🔸 Repository Discovery'));
      
      try {
        const userRepos = await this.coreLimiter.schedule(async () => {
          const response = await this.makeRequest(
            `${this.options.baseURL}/users/${options.searchUser}/repos?per_page=100&type=all&sort=updated`
          );
          return response.map(repo => RepositorySchema.parse(repo));
        });
        
        repositories = userRepos;
        console.log(chalk.green(`📊 Discovered ${repositories.length} repositories for user ${options.searchUser}`));
      } catch (error) {
        throw new Error(`Failed to discover repositories for user ${options.searchUser}: ${error.message}`);
      }
    }

    if (repositories.length === 0) {
      throw new Error('No valid repositories found to search');
    }

    // Check for resume capability
    const existingProgress = await checkpoint.load();
    let startIndex = 0;
    
    if (existingProgress && existingProgress.processedSearches) {
      console.log(chalk.yellow(`🔄 Found previous progress: ${existingProgress.processedSearches} searches completed`));
      startIndex = existingProgress.processedSearches;
    }

    // Setup file paths
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseFilename = options.filename || `github-search-terms-${timestamp}`;
    const outputFile = path.join(outputDir, `${baseFilename}.${options.format || 'json'}`);
    const auditFile = path.join(outputDir, `${baseFilename}.audit.json`);

    // Initialize streaming writers
    let writer;
    const format = options.format || 'json';
    
    if (format === 'json') {
      writer = new StreamingJsonWriter(outputFile);
      await writer.open({
        inputs: {
          searchTerms: options.contains,
          repositories: repositories.map(r => r.full_name),
          contentTypes: ['pulls', 'issues', 'commits', 'code'],
          dateRange: dateRange,
          generatedAt: new Date().toISOString(),
          ...options
        },
        metaTags: this.parseMetaTags(options.metaTags || []),
        summary: {
          totalSearches: 0,
          totalResults: 0,
          successfulSearches: 0,
          failedSearches: 0
        }
      });
    } else {
      const csvHeaders = [
        'search_term', 'repository', 'content_type', 'result_id', 'result_number',
        'title', 'body', 'author', 'url', 'created_at', 'updated_at', 'state'
      ];
      writer = new StreamingCsvWriter(outputFile, csvHeaders);
      await writer.open();
    }

    // Process searches with streaming
    console.log(chalk.blue.bold('\n🔸 Search Analysis'));
    
    const totalSearches = repositories.length * options.contains.length * 4; // 4 content types
    let processedSearches = startIndex;
    let totalResults = 0;
    let successfulSearches = 0;
    let failedSearches = 0;

    await CLIProgressHelper.withProgress(
      totalSearches - startIndex,
      'Executing repository searches',
      async (updateProgress) => {
        for (const repo of repositories) {
          for (const term of options.contains) {
            const contentTypes = ['pulls', 'issues', 'commits', 'code'];
            
            for (const contentType of contentTypes) {
              // Skip if already processed
              if (processedSearches > 0) {
                processedSearches--;
                updateProgress(1);
                continue;
              }

              try {
                this.log(`Searching ${contentType} in ${repo.full_name} for term: ${term}`);
                
                let results = [];
                
                switch (contentType) {
                  case 'pulls':
                    results = await this.searchPullRequests(repo, term, dateRange);
                    break;
                  case 'issues':
                    results = await this.searchIssues(repo, term, dateRange);
                    break;
                  case 'commits':
                    results = await this.searchCommits(repo, term, dateRange);
                    break;
                  case 'code':
                    results = await this.searchCode(repo, term);
                    break;
                }

                const searchData = {
                  term: term,
                  repository: repo.full_name,
                  contentType: contentType,
                  results: results,
                  totalResults: results.length,
                  searchedAt: new Date().toISOString()
                };

                // Stream to file immediately
                if (format === 'json') {
                  await writer.writeSearch(searchData);
                } else {
                  // Write CSV rows for each result
                  for (const result of results) {
                    await writer.writeRow({
                      search_term: term,
                      repository: repo.full_name,
                      content_type: contentType,
                      result_id: result.id || result.sha || result.name || '',
                      result_number: result.number || '',
                      title: result.title || result.message || result.name || '',
                      body: result.body || '',
                      author: result.author?.login || result.author?.name || result.author || '',
                      url: result.url || result.html_url || '',
                      created_at: result.createdAt || result.date || '',
                      updated_at: result.updatedAt || '',
                      state: result.state || ''
                    });
                  }
                }

                totalResults += results.length;
                successfulSearches++;
                
                // Save checkpoint
                await checkpoint.save({
                  processedSearches: processedSearches + 1,
                  successfulSearches,
                  failedSearches,
                  totalResults
                });

                this.log(`Successfully searched ${contentType} in ${repo.full_name} for "${term}": ${results.length} results`);
                
                // Validate search results using expect
                try {
                  expect(results).toBeInstanceOf(Array);
                  expect(results.length).toBeGreaterThanOrEqual(0);
                  if (results.length > 0) {
                    expect(results[0]).toHaveProperty('contentType');
                  }
                } catch (validationError) {
                  this.log(`Search result validation failed: ${validationError.message}`, 'error');
                }
                
              } catch (error) {
                this.log(`Failed to search ${contentType} in ${repo.full_name} for "${term}": ${error.message}`, 'error');
                failedSearches++;
                
                // Stream error record for JSON format
                if (format === 'json') {
                  await writer.writeSearch({
                    term: term,
                    repository: repo.full_name,
                    contentType: contentType,
                    error: error.message,
                    searchedAt: new Date().toISOString()
                  });
                }
              }
              
              processedSearches++;
              updateProgress(1);
              
              // Respect delay between searches
              if (options.delay) {
                await new Promise(resolve => setTimeout(resolve, options.delay * 1000));
              }
            }
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
    console.log(`✅ Successfully processed  : ${successfulSearches} searches`);
    console.log(`❌ Failed to process       : ${failedSearches} searches`);
    console.log(`📊 Total searches          : ${totalSearches} searches`);
    console.log(`📂 Total results           : ${totalResults} results`);
    console.log(`📈 Success rate            : ${((successfulSearches / (successfulSearches + failedSearches)) * 100).toFixed(1)}%`);
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
    console.log(`🔍 Search Terms           : ${options.contains.join(', ')}`);
    console.log(`📂 Repositories Analyzed  : ${repositories.length}`);
    console.log(`📊 Total Searches         : ${totalSearches}`);
    console.log(`✅ Successful Searches    : ${successfulSearches}`);
    console.log(`❌ Failed Searches        : ${failedSearches}`);
    console.log(`📈 Total Results Found    : ${totalResults}`);
    console.log(`📄 Report Location        : ${outputFile}`);
    if (options.debug) {
      console.log(`🔍 Audit File Location    : ${auditFile}`);
    }
    console.log('─'.repeat(60));

    return {
      totalSearches,
      successfulSearches,
      failedSearches,
      totalResults,
      repositories: repositories.length,
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
  .name('github-repo-search-terms')
  .description('Search GitHub repositories for specific terms across pull requests, issues, commits, and codebase')
  .version('1.0.0')
  .option('--org <org>', 'GitHub organization to filter repositories')
  .option('--repo <repo>', 'Comma-separated list of repository identifiers (name, ID, or node_id)')
  .option('--searchUser <userIdentifier>', 'GitHub username to discover repositories from')
  .option('--contains <terms...>', 'Search terms to look for (can be used multiple times)', [])
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
    // Validate required options
    if (options.contains.length === 0) {
      throw new Error('At least one search term must be provided via --contains');
    }

    if (!options.repo && !options.org && !options.searchUser) {
      throw new Error('Repository must be specified via --repo, --org, or --searchUser');
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

    const analyzer = new GithubRepoSearchTerms(options);
    await analyzer.analyze(options);

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

export default GithubRepoSearchTerms;
