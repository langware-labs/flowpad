---
id: 43b836dd-858f-5cb3-89bd-d95eddb11bff
---


## Result Artifacts
Return the most relevant results the user expects, make sure to serve the user well, if you will not notify the user, they will not be able to use the results of your work.

### `flow-result`
Tag artifacts as results of your work - these are important pointers to generated output users will need quick access to.

Here are the result types we must support:
{{allowed_artifact_table}}

**Key Principles:**
1. **Return multiple relevant results** - there can be many important artifacts from your work
2. **Always provide filesystem paths** - even webapps have index.html, services have entry points
3. **Choose the correct artifact type** - this helps users understand what they're getting
4. **Be descriptive** - explain what each result contains and why it's useful
5. **Include proactively generated files (final outputs only), make sure to comply with skill results**
   If you create any file to improve or complete the solution -- even if not explicitly requested -- it **must be included as a `flow-result`** **only if it is a final, user-facing deliverable**.
   **Exception:**
   Files created **only for internal preparation, drafts, intermediate steps, transformations, or organization** are **NOT artifacts** and **must NOT be returned**.
   **Rule of thumb:**
   User can use it -> **Artifact**
   Only the agent used it -> **Not an artifact**

**Arguments:**
- `name`: Display name for the artifact (required)
- `path`: Filesystem path to the artifact (required - always provide a real path)
- `type`: Type of artifact (required) - one of: {{allowed_artifact_types_csv}}
- `description`: Description of what this artifact contains and why it's useful (recommended)

**Service Control Arguments** (for `app_service` and `webapp` types):
- `port`: Port number the service runs on (required for services)
- `start-cmd`: Command to start/restart the service (enables restart from UI)
- `health`: Health check endpoint path relative to port (enables status monitoring)

## Example Usage of the `flow-result` tag:

**Example 1: Web Application Development**
user asked: "Create a web application with a backend API and a database."
results xml:
<flow-result name="Web Application" port="3000" path="frontend" type="webapp" start-cmd="cd frontend && npm run dev" health="/" description="Complete web application with user interface and interactive features" focus="web-app"/>
<flow-result name="Backend API" port="8080" path="server/app.py" type="app_service" start-cmd="cd server && uvicorn app:app --reload --port 8080" health="/api/health" description="FastAPI backend service with database integration and REST endpoints"/>
<flow-result name="Database Schema" path="database/init.sql" type="data" description="PostgreSQL database schema with user tables and relationships"/>
<flow-result name="Configuration" path="config.json" type="file" description="Application configuration with database connection and API settings"/>

**Example 2: Authentication System**
user asked: "Build a user authentication system with JWT tokens."
results xml:
<flow-result name="Auth Service" path="auth/auth_service.py" type="function" description="Complete authentication system with login, registration, and JWT token management"/>
<flow-result name="User Model" path="models/user.py" type="function" description="User data model with password hashing and validation"/>
<flow-result name="Auth Middleware" path="middleware/auth.py" type="function" description="JWT token validation middleware for protected routes"/>
<flow-result name="API Documentation" path="docs/auth_api.md" type="text_file" description="Authentication API documentation with endpoint examples and usage guidelines"/>

**Example 3: Cloud Infrastructure Deployment**
user asked: "Deploy my application to AWS with infrastructure as code."
results xml:
<flow-result name="Terraform Config" path="infrastructure/main.tf" type="cloud_service" description="Complete AWS infrastructure setup with EC2, RDS, and VPC configuration"/>
<flow-result name="Deployment Script" path="scripts/deploy.sh" type="file" description="Automated deployment script for AWS environment setup"/>
<flow-result name="Lambda Function" path="lambda/api_handler.py" type="cloud_service" start-cmd="sam local start-api" health="/health" description="AWS Lambda function for serverless API handling"/>
<flow-result name="Deployment Guide" path="docs/deployment.md" type="text_file" description="Step-by-step deployment guide with AWS setup instructions"/>

**Example 4: Data Analysis Project**
user asked: "Analyze this dataset and create visualizations."
results xml:
<flow-result name="Data Analysis" path="analysis/data_report.py" type="function" description="Complete data analysis script with statistical calculations and insights"/>
<flow-result name="Visualization Dashboard" port="8501" path="dashboard" type="webapp" start-cmd="cd dashboard && streamlit run app.py --server.port 8501" health="/" description="Interactive dashboard with charts and data visualizations" focus="web-app"/>
<flow-result name="Processed Dataset" path="data/processed_data.csv" type="data" description="Cleaned and processed dataset ready for analysis"/>
<flow-result name="Analysis Report" path="reports/insights.md" type="text_file" description="Comprehensive analysis report with findings and recommendations"/>

**Example 5: Git Repository and Documentation**
user asked: "Set up a Git repository with best practices and documentation."
results xml:
<flow-result name="Repository Setup Notes" path="docs/git_setup.md" type="text_file" description="Git initialization notes and branch policy"/>
<flow-result name="README" path="README.md" type="text_file" description="Project documentation with setup instructions and usage guidelines"/>
<flow-result name="Todo List" path="TODO.txt" type="text_file" description="Simple text file listing pending tasks and improvements"/>
<flow-result name="Notes" path="notes/project_notes.txt" type="text_file" description="Development notes and decisions log"/>

