import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BusinessException, PayloadUser } from '@app/common';

import { getBranchPrefix } from '@devopsServer/utils/helper';

import { TaskService } from './task.service';
import { PublishStatus, Task } from './task.entity';
import {
  IPublishType,
  ListWithPaginationDto,
  PublishDto,
  PublishNewDto,
  PublishPreCheckResult,
  PublishTypeEnum,
  QueryByIronTaskIdDto,
  RollbackDiffDto,
  RollbackDto,
  TaskExtraFields,
  UpdateTaskDto,
  UpdateTaskIronDto,
  versionMap,
  versionTypeMap,
} from './task.dto';

import { ProjectService } from '@devopsServer/project/project.service';
import { ProcessService } from '@devopsServer/iteration/process/process.service';
import {
  Process,
  ProcessEnvGroupNames,
  ProcessNodes,
} from '@devopsServer/iteration/process/process.entity';
import { IterationService } from '@devopsServer/iteration/iteration.service';
import {
  Iteration,
  IterationStatus,
  updateVersionType,
} from '@devopsServer/iteration/iteration.entity';

import { RepositoryService } from '@devopsServer/common/repository/repository.service';
import { JenkinsService } from '@devopsServer/common/jenkins/jenkins.service';
import { BranchService } from '@devopsServer/branch/branch.service';
import { Branch } from '@devopsServer/branch/branch.entity';
import { Project } from '@devopsServer/project/project.entity';
import { Pagination } from 'nestjs-typeorm-paginate';
import { ThirdMiniProgramService } from '@devopsServer/project/third-mini-program/third-mini-program.service';
import { ProjectConfiguration } from '@devopsServer/project/project-configuration/project-configuration.entity';
import { ProjectConfigurationService } from '@devopsServer/project/project-configuration/project-configuration.service';
import { DeployHistoryService } from '../history/history.service';

import {
  CreateTask,
  Operation,
  OperationType,
} from '@devopsServer/system/operation/operation.entity';

import { OperationService } from '@devopsServer/system/operation/operation.service';
import { isEmpty } from 'class-validator';
import {
  getAssetUrl,
  getBranchAndDeployEnv,
  getDeployEnv,
  getEnvName,
  isProjectTypeSupportMicroFe,
  validityPublishEnv,
} from './helper';

import * as semver from 'semver';

import { ConfigService } from '@nestjs/config';
import { ProcessFlowService } from '@devopsServer/iteration/process/processFlow/processFlow.service';
import { ProcessNodeService } from '@devopsServer/iteration/process/processNode/processNode.service';
import { getEnv, Public } from '@app/common';

const DEFAULT_QUEUE_ID = 0;

@ApiTags('任务')
@Controller('task')
export class TaskController {
  private ASSETS_PATH;
  private OPTIMUS_STATUS_URL;
  constructor(
    private userSerivce: UserService,
    private taskService: TaskService,
    private processService: ProcessService,
    private iterationService: IterationService,
    private repositoryService: RepositoryService,
    private branchService: BranchService,
    private projectService: ProjectService,
    private operationService: OperationService,
    private jenkinsService: JenkinsService,
    private thirdMiniProgramService: ThirdMiniProgramService,
    private projectConfigurationService: ProjectConfigurationService,
    private configService: ConfigService,
    private deployHistoryService: DeployHistoryService,
    private processFlowService: ProcessFlowService,
    private processNodeService: ProcessNodeService,
  ) {
    this.ASSETS_PATH = this.configService.get('ASSETS_PATH');
    this.OPTIMUS_STATUS_URL = this.configService.get('OPTIMUS_STATUS_URL');
  }

  @Post('updateTaskStatus')
  @Public()
  async updateTask(@Body() updateTaskDto: UpdateTaskDto) {
    const { id, status = PublishStatus.unpublished, buildId } = updateTaskDto;
    // 兼容字符串类型
    const numberedStatus = Number(status);

    const task: Task = await this.taskService.findById(id);
    const updatedTask = { ...task, buildId };
    numberedStatus && (updatedTask.status = numberedStatus);

    const iteration: Iteration = await this.iterationService.findIterationById(
      task.iterationId,
    );

    if (!iteration) throw new BusinessException('未找到迭代，更新状态失败！');

    // 已经发布成功。
    if (numberedStatus === PublishStatus.publish_success) {
      // 任务执行环境是流程的生产环境
      if (task.env === ProcessNodes.production) {
        // 进入 已发布代码未合并到 master 状态
        iteration.currentProcessNode = ProcessNodes.production_not_merge;
        if (!iteration.subProcessNodes) iteration.subProcessNodes = {};
        iteration.subProcessNodes[task.projectType] =
          ProcessNodes.production_not_merge;
      } else {
        iteration[versionMap[task.env]] = iteration[versionMap[task.env]] + 1;
      }
      await this.iterationService.createOrUpdate(iteration);

      if (task.projectType === 'gateway') {
        await this.nacosService.uploadConfig(
          task.env,
          task.nacosConfig && JSON.parse(task.nacosConfig),
        );
      }
    }

    // 记录发布成功
    // const record: ProdPublishSuccess = {
    //   iterationId: task.iterationId,
    // };

    // updatedTask.endTime = new Date().toLocaleTimeString();
    this.taskService.updateById(task.id, updatedTask);
  }

  @Post('updateTaskStatusIron')
  @Public()
  async updateTaskStatusIron(@Body() updateTaskIronDto: UpdateTaskIronDto) {
    let success = false;
    const { id, buildId, result, hookStep } = updateTaskIronDto;
    const task: Task = await this.taskService.findById(id);

    try {
      const DEPLOY_TASK_STATUS_TO_STATUS_MAP = {
        default: PublishStatus.publishing,
        ['FAILURE']: PublishStatus.publish_failed,
        ['SUCCESS']: PublishStatus.publish_success,
      };
      const updatedTask = {
        ...task,
        buildId,
        status:
          DEPLOY_TASK_STATUS_TO_STATUS_MAP[result] ||
          DEPLOY_TASK_STATUS_TO_STATUS_MAP.default,
      };
      if (task.projectType === 'gateway') {
        await this.nacosService.uploadConfig(
          task.env,
          task.nacosConfig && JSON.parse(task.nacosConfig),
        );
      }
      this.taskService.updateById(task.id, updatedTask);
      success = true;
    } finally {
      const requestOption = {
        url: this.OPTIMUS_STATUS_URL,
        option: {
          method: 'POST',
          data: {
            result: success ? result : 'FAILURE',
            hookStep,
            taskId: task.ironTaskId,

            // region 与 cmdb 保持一致
            buildId, // Jenkins 构建ID
            number: task.id, // 构建序号
            queueId: task.queueId, // Jenkins 队列ID
            // endregion
          },
        },
      };
      const { status, data } = await request(requestOption);
      if (status !== 200 || data.code != 200) {
        throw new BusinessException(
          JSON.stringify(requestOption) +
          '\n状态回调失败\n' +
          JSON.stringify(data),
        );
      }
      return requestOption;
    }
  }

  async packageNacos(
    { projectType, domainId = '', nodeId = 1, environment },
    deployEnv,
  ) {
    if (projectType === 'gateway' && domainId) {
      try {
        const domain = await this.domainService.findOneById(domainId);
        const { nacosGroup, nacosDataId, nacosTenant, nacosUrl } = domain;

        const exist = await this.domainService.findByNodeId({
          path: domain.path,
          name:
            environment === ENV_NODES.pre ? `${domain.name}.pre` : domain.name,
          host: domain.host,
          env: environment,
          nodeId,
        });

        if (!exist) {
          this.domainService.createOrUpdate({
            path: domain.path,
            name:
              environment === ENV_NODES.pre
                ? `${domain.name}.pre`
                : domain.name,
            host: domain.host,
            projectId: domain.projectId,
            nacosDataId: domain.nacosDataId,
            nacosGroup: domain.nacosGroup,
            nacosTenant: domain.nacosTenant,
            nacosId: domain.nacosId,
            nacosUrl: domain.nacosUrl,
            env: environment,
            nodeId,
          });
        }

        const transfor = `${environment === ProcessNodes.pre ? 'pre' : deployEnv
          }-${nodeId}-${nacosTenant}`;

        console.log({
          nacosGroup,
          nacosDataId,
          nacosTenant: transfor,
          env: environment,
        });

        const tenant = await this.nacosService.judgeNacos({
          nacosTenant: transfor,
          env: environment,
        });

        console.log({
          NACOS_CONFIG: {
            url: this.nacosService.NACOS_CONFIG[
              environment === ProcessNodes.pre ? 'pre' : deployEnv
            ],
            group: nacosGroup,
            tenant,
            dataId: `${nacosDataId}.html`,
          },
          TASK_NACOS_CONFIG: {
            nacosGroup,
            nacosDataId,
            nacosTenant,
            nacosUrl,
            tenant,
            nodeId,
          },
          domain,
        });

        return {
          NACOS_CONFIG: {
            url: this.nacosService.NACOS_CONFIG[
              environment === ProcessNodes.pre ? 'pre' : deployEnv
            ],
            group: nacosGroup,
            tenant,
            dataId: `${nacosDataId}.html`,
          },
          TASK_NACOS_CONFIG: {
            nacosGroup,
            nacosDataId,
            nacosTenant,
            nacosUrl,
            tenant,
            nodeId,
          },
          domain,
        };
      } catch (error) {
        console.log(error);
        throw new BusinessException('nacos 创建失败，请联系管理员');
      }
    }
    return { NACOS_CONFIG: '', TASK_NACOS_CONFIG: '', domain: '' };
  }

  creatRecord(task, project, iteration, expectedDeployEnv, projectType, user) {
    const record: CreateTask = {
      taskId: task.id,
      projectId: project.id,
      iterationId: iteration.id,
      env: expectedDeployEnv,
      projectType,
      iterationName: iteration.name,
    };

    const operation: Operation = {
      operationType: OperationType.create_task,
      operatorId: user.userId,
      operatorName: user.name,
      record: JSON.stringify(record),
    };
    this.operationService.createOrUpdate(operation);
  }

  async verifyAuth(publishDto: PublishDto, user) {
    if (publishDto.environment !== ProcessNodes.development) {
      if (
        !(await this.userSerivce.hasPermission({
          user,
          projectId: publishDto.fprojectId,
          path: PROJECT_PERMISSION_MAP.publish,
          envGroup: ProcessEnvGroupNames[publishDto.environment],
        }))
      ) {
        BusinessException.throwForbidden();
      }
    }
  }

  async verifyProcess(publishDto, iteration, project, process, projectType) {
    // 迭代校验
    if (!iteration) {
      throw new BusinessException(`未找到迭代信息`);
    }
    if (iteration.status === IterationStatus.deprecated) {
      throw new BusinessException(`迭代已废弃`);
    }
    // 流程校验
    if (!process) {
      throw new BusinessException(`未找到流程信息`);
    }
    // 项目校验
    if (!project) {
      throw new BusinessException(`未找到该项目`);
    }
    // 校验发布环境合法性
    const expectedDeployEnv =
      publishDto.environment === ENV_NODES.pre
        ? ENV_NODES.fix
        : publishDto.environment;

    // 校验 审批单
    if (
      expectedDeployEnv === ProcessNodes.production &&
      projectType !== 'npm'
    ) {
      if (!iteration.feishuApprovalInstanceCode) {
        throw new BusinessException('无审批信息');
      }
      const feishuApprovalInstance =
        await this.feishuService.getApprovalByInstanceCode(
          iteration.feishuApprovalInstanceCode,
        );

      if (feishuApprovalInstance.status !== FeishuApprovalStatus.APPROVED) {
        const msg = {
          [FeishuApprovalStatus.PENDING]: '正在审批中...',
          [FeishuApprovalStatus.REJECTED]: '已拒绝',
          [FeishuApprovalStatus.TRANSFERRED]: '审批已扭转，请等待...',
        };
        throw new BusinessException(msg[feishuApprovalInstance.status] || '');
      }
    }

    const currentProcessNode = process.currentProcessNode;

    if (!validityPublishEnv(expectedDeployEnv, currentProcessNode)) {
      throw new BusinessException('发布环境不符合规则');
    }
    // 获取期望发布环境的分支和构建部署环境
    const branchEnv = getBranchAndDeployEnv(
      expectedDeployEnv,
      iteration,
      project,
      projectType,
    );

    // 判断发布配置选项
    const projectConfiguration: ProjectConfiguration =
      await this.projectConfigurationService.findOne(project.id, projectType);

    if (
      isEmpty(projectConfiguration?.deployConfig || project.deployConfig) &&
      projectType !== 'iOS' &&
      projectType !== 'nodejs' &&
      projectType !== 'android'
    ) {
      throw new BusinessException('请先设置应用发布配置！');
    }

    if (!branchEnv) {
      throw new BusinessException('未找到当前发布环境');
    }
    const branch: Branch = await this.branchService.findBranchByName(
      branchEnv.deployBranch,
      project.id,
    );

    if (!branch) {
      throw new BusinessException(`未找到该分支`);
    }

    return { branchEnv, expectedDeployEnv, projectConfiguration };
  }

  async packageWeapp3rd(
    publishDto,
    project,
    expectedDeployEnv,
    task,
    projectConfiguration,
  ) {
    const WEAPP3RD_ACCESS_TOKEN = await this.redisService.get(
      this.redisService.REDIS_CONFIG.key,
    );
    const thirdMiniPrograms = await this.thirdMiniProgramService.findByIds(
      publishDto.thirdMiniIds,
      project.id,
      expectedDeployEnv,
    );

    if (!thirdMiniPrograms)
      throw new BusinessException('请先选择第三方小程序商户！');

    const authentication: any =
      projectConfiguration?.authentication &&
      JSON.parse(projectConfiguration.authentication);

    return {
      WEAPP3RD_ACCESS_TOKEN,
      T_CONFIG: JSON.stringify({
        taskId: task.id,
        projectId: project.id,
        exts: thirdMiniPrograms,
      }),
      authentication:
        projectConfiguration?.authentication &&
        JSON.parse(projectConfiguration.authentication),
      WEAPP_KEY: authentication.secretToken || project.secretToken,
      MP_APPID: authentication.appId || project.appId,
    };
  }

  updateProcess(iteration, process, expectedDeployEnv, deployBranch, task) {
    if (
      [
        ProcessNodes.apply_for_test,
        ProcessNodes.apply_for_fix,
        ProcessNodes.production_not_merge,
      ].includes(iteration.currentProcessNode)
    ) {
      iteration.currentProcessNode = expectedDeployEnv;
    }

    if (
      [
        ProcessNodes.apply_for_test,
        ProcessNodes.apply_for_fix,
        ProcessNodes.production_not_merge,
      ].includes(process.currentProcessNode)
    ) {
      process.currentProcessNode = expectedDeployEnv;
    }

    process.currentEnvBranch = deployBranch;

    const addTaskIdToProcess = {
      [ProcessNodes.development]: (id: number) =>
        (process.devCurrentTaskId = id),
      [ProcessNodes.testing]: (id: number) => (process.testCurrentTaskId = id),
      [ProcessNodes.fix]: (id: number) => (process.fixCurrentTaskId = id),
      [ProcessNodes.pre]: (id: number) => (process.fixCurrentTaskId = id),
      [ProcessNodes.production]: (id: number) =>
        (process.prodCurrentTaskId = id),
    };

    addTaskIdToProcess[expectedDeployEnv](task.id);

    // 更新 流程
    this.processService.createOrUpdate(process);
    // 更新 迭代
    this.iterationService.createOrUpdate(iteration);
  }

  async verifyMerge(
    iteration,
    project,
    projectType,
    expectedDeployEnv,
    deployBranch,
    user,
  ) {
    const isHotfix = iteration.updateVersionType === updateVersionType.hotfix;

    // 如果期望发布的是fix、prod环境，则自动合并上一个分支代码到期望分支。
    const processTemplate = await this.processFlowService.findByName(
      isHotfix ? 'hotfix' : projectType,
    );

    const processNodeList = await this.processNodeService.findByIds(
      processTemplate.nodeIds,
    );

    const currentNode =
      await this.processNodeService.findByEnv(expectedDeployEnv);
    const nodeIds = processTemplate.nodeIds as unknown as string[];

    const currentIndex = nodeIds.indexOf(String(currentNode.id));
    if (currentIndex <= 0) return;
    const preEnv = processNodeList[currentIndex - 1];

    const prefix = getBranchPrefix(
      projectType,
      iteration.multiBranch,
      project.projectTypes,
    );

    const source_branch = `${prefix}${isHotfix ? 'hotfix' : preEnv.type}/${iteration.version
      }`;

    console.log('source_branch====>', source_branch);

    const mergeParams = {
      id: project.gitProjectId,
      title: `迭代为【${iteration.name}-${iteration.version}】的合并请求`,
      source_branch,
      target_branch: deployBranch,
    };
    await this.repositoryService.autoMerge(mergeParams, user.gitAccessToken);
  }

  async packageMicrofe(
    {
      microModules,
      projectType,
      environment,
    }: { microModules?: any; projectType: any; environment: number },
    project,
    domain,
    task,
    iteration: Iteration | undefined,
    deployEnv,
    planLink = {} as TOpsReleasePlanLink,
  ) {
    const microConfig = domain?.microConfig;

    const remoteApps = {};

    for (const { projectId, iterationId } of microModules) {
      const childProject = await this.projectService.findProjectById(projectId);
      const childIteration =
        await this.iterationService.findIterationById(iterationId);
      const childIterationVersion = childIteration.version;
      remoteApps[childProject.gitProjectName] = getAssetUrl({
        assetPath: this.ASSETS_PATH[deployEnv],
        gitProjectName: childProject.gitProjectName,
        version: childIterationVersion,
      });
    }

    this.deployHistoryService.save({
      projectId: project.id,
      projectType: projectType,
      taskId: task.id,
      iterationId: iteration?.id,
      version: iteration?.version || planLink.deployVersion,
      environment: environment,
      microConfig: microModules,
      domainId: domain?.id,
    });

    return {
      SHIELD_WEB_CONFIG: JSON.stringify({
        name: project.gitProjectName,
        config: microConfig,
        remoteApps,
      }),
    };
  }

  @ApiOperation({
    summary: '发布（开发、测试、预发、生产）预校验',
    description: '软提示返回结果，硬提示报错',
  })
  @Post('publish/preCheck')
  async preCheckPublish(
    @Body() publishDto: PublishDto,
    @PayloadUser() user: IPayloadUser,
    iteration?: Iteration,
    project?: Project,
  ) {
    const preCheckMessageList = [];

    if (publishDto.projectType === 'gateway' && getEnv() !== 'prod') {
      throw new BusinessException('研发工作台线下环境禁止发布网关服务');
    }

    // 权限要求
    await this.verifyAuth(publishDto, user);

    if (!iteration) {
      iteration = await this.iterationService.findIterationById(
        publishDto.iterationId,
      );
    }

    if (!project) {
      project = await this.projectService.findProjectById(iteration.projectId);
    }

    if (publishDto.lock && !iteration.fplanId) {
      throw new BusinessException('仅支持在发布计划中锁定环境');
    }

    if (publishDto.environment === ProcessNodes.production) {
      const notMergeIteration =
        await this.iterationService.findIterationByProcess(
          iteration.projectId,
          ProcessNodes.production_not_merge,
        );
      if (notMergeIteration) {
        const extra = {
          name: notMergeIteration.name,
          creatorName: notMergeIteration.creatorName,
        };
        preCheckMessageList.push({
          type: PublishPreCheckResult.hasNotMergeProd,
          extra,
        });
      }
    }

    if (publishDto.environment === ProcessNodes.production) {
      // 获取期望发布环境的分支和构建部署环境
      const { deployBranch } = getBranchAndDeployEnv(
        publishDto.environment,
        iteration,
        project,
        publishDto.projectType,
      );
      const compareResult = await this.repositoryService.getProjectCompare(
        project.gitProjectId,
        deployBranch,
        'master',
      );
      if (compareResult.data.compare_timeout) {
        preCheckMessageList.push({
          type: PublishPreCheckResult.warn,
          message:
            '检查发布分支与主干 Master 差异超时，请手动确认 master 是否存在更新',
        });
      }
      if (compareResult.data.commit) {
        throw new BusinessException(
          '发布分支落后于主干分支（Master），请先合并主干代码',
        );
      }
    }

    return preCheckMessageList;
  }

  @ApiOperation({
    summary: '发布（开发、测试、预发、生产）',
    description:
      '成功创建`迭代`（Iteration）后，根据`项目类型`创建对应个数的`流程`（Process），更新项目信息的`最新迭代版本号`。',
  })
  @Post('publish')
  async publish(
    @Body() publishDto: PublishDto,
    @PayloadUser() user: IPayloadUser,
  ) {
    const { iterationId, projectType, domainId } = publishDto;

    const iteration: Iteration =
      await this.iterationService.findIterationById(iterationId);

    const { projectId } = iteration;

    const project: Project =
      await this.projectService.findProjectById(projectId);

    await this.preCheckPublish(publishDto, user, iteration, project);

    const process: Process = await this.processService.findProcess({
      iterationId,
      projectId,
      projectType,
    });

    const { branchEnv, expectedDeployEnv, projectConfiguration } =
      await this.verifyProcess(
        publishDto,
        iteration,
        project,
        process,
        projectType,
      );

    const { deployBranch, deployEnv } = branchEnv;

    await this.verifyMerge(
      iteration,
      project,
      projectType,
      expectedDeployEnv,
      deployBranch,
      user,
    );

    // 网关特殊任务修改
    const {
      NACOS_CONFIG = '',
      TASK_NACOS_CONFIG = '',
      domain,
    }: {
      NACOS_CONFIG: any;
      TASK_NACOS_CONFIG: any;
      domain: any;
    } = await this.packageNacos(publishDto, deployEnv);

    // 创建 任务
    const task: Task = await this.taskService.publish({
      projectType,
      env: publishDto.environment,
      branch: deployBranch,
      creatorId: user.userId,
      creatorName: user.name,
      processId: process.id,
      projectId: projectId,
      iterationId: iterationId,
      status: PublishStatus.publishing,
      queueId: 0,
      desc: publishDto.desc,
      nacosConfig: JSON.stringify(TASK_NACOS_CONFIG),
      domainId,
    });

    if (!task) {
      throw new BusinessException('任务创建失败');
    }

    // 保存操作记录
    this.creatRecord(
      task,
      project,
      iteration,
      expectedDeployEnv,
      projectType,
      user,
    );

    // 触发 Jenkins
    let jenkinsParams: H5JenkinsParams = {
      DEPLOY_CONFIG: projectConfiguration?.deployConfig || project.deployConfig, // 前端发布配置
      NACOS_CONFIG: NACOS_CONFIG.url
        ? JSON.stringify(NACOS_CONFIG)
        : projectConfiguration?.nacosConfig || project.nacosConfig, // 前端发布 nacos 配置
      PROJECT_GIT_PATH: `${project.gitProjectUrl.replace('http://', '')}.git`, // 项目 git 地址
      PROJECT_NAME: project.gitProjectName, // 项目 git 名称
      PROJECT_VERSION: iteration.version, // 迭代版本
      BRANCH_NAME: deployBranch, // 发布分支
      CACHE: !!publishDto.cache, // 是否缓存
      PIPELINE_STEPS: JSON.stringify({
        dependencies: true,
        build: true,
        test: false,
        deploy: true,
      }), // 构建步骤
      PROJECT_ID: project.id, // 项目 id
      COMMITS_SHA: '', // 提交sha
      DEPLOY_ENV:
        publishDto.environment === ProcessNodes.pre ? 'pre' : deployEnv, // 发布环境
      DOCKER_PUBLISHER:
        projectConfiguration?.builderDocker || DOCKER_PUBLISHER[projectType], // 构建 docker 版本
      USER_EMAIL: user.email, // 发布人员邮箱
      NAMESPACE: `${project.gitNamespace}/${project.gitProjectName}`, // git namespace
      TASK_ID: task.id, // 任务 id，方便回调
      ARCHIVE_USER: user.name, // 发布人
      DESC: publishDto.desc, // 发布描述
      SHIELD_WEB_CONFIG: JSON.stringify({
        name: project.gitProjectName,
        remoteApps: {},
      }),
    };

    // 三方小程序配置项
    if (projectType === 'weapp3rd') {
      const extraParams = await this.packageWeapp3rd(
        publishDto,
        project,
        expectedDeployEnv,
        task,
        projectConfiguration,
      );
      jenkinsParams = { ...jenkinsParams, ...extraParams };
    }

    // 微服务配置
    if (publishDto.publishType === IPublishType.micro) {
      const extraParams = await this.packageMicrofe(
        publishDto,
        project,
        domain,
        task,
        iteration,
        publishDto.environment === ProcessNodes.pre ? 'pre' : deployEnv,
      );
      jenkinsParams = { ...jenkinsParams, ...extraParams };
    }

    // 微服务直接修改nacos
    if (publishDto.publishType === IPublishType.microChild) {
      const html = await this.nacosService.getHtml(
        expectedDeployEnv,
        NACOS_CONFIG,
      );
      const { SHIELD_WEB_CONFIG } = await this.packageMicrofe(
        publishDto,
        project,
        domain,
        task,
        iteration,
        deployEnv,
      );
      const shieldWebConfig = JSON.parse(SHIELD_WEB_CONFIG || '{}');
      if (shieldWebConfig.config) {
        shieldWebConfig.config = JSON.parse(shieldWebConfig.config);
      }
      const injectHtml = injectShieldConfig(html, shieldWebConfig);
      await this.nacosService.uploadHtml(
        expectedDeployEnv,
        { nacosGroup: NACOS_CONFIG.group, ...NACOS_CONFIG },
        injectHtml,
      );
      await this.updateTask({
        id: task.id,
        status: PublishStatus.publish_success,
      });
      return task;
    }

    // npm 配置项附增
    if (projectType === 'npm') {
      let deployVersion = iteration.version;
      let deployNum = 1;

      if (expectedDeployEnv !== ProcessNodes.production) {
        deployVersion = `${deployVersion}-${versionTypeMap[expectedDeployEnv]
          }.${iteration[versionMap[expectedDeployEnv]] + 1}`;
        deployNum = iteration[versionMap[expectedDeployEnv]] + 1;
      }
      jenkinsParams = {
        ...jenkinsParams,
        ...{
          PROJECT_VERSION: deployVersion,
          PROJECT_NAME: project.usName,
        },
      };
    }

    try {
      const { data } = await this.jenkinsService.buildH5({
        type: projectType,
        job: JENKINS_MAP[projectType],
        params: jenkinsParams,
      });

      // 获取Jenkins 回调队列 id 插入 task
      this.taskService.updateById(task.id, { ...task, queueId: data.queueId });
    } catch (error) {
      this.taskService.updateById(task.id, {
        ...task,
        status: PublishStatus.publish_failed,
      });
      console.log(error);
    }

    // 如果当前流程节点在下面的几个状态，需要更新迭代、流程状态。
    this.updateProcess(
      iteration,
      process,
      expectedDeployEnv,
      deployBranch,
      task,
    );

    return task;
  }

  @ApiOperation({
    summary: '发布（开发、测试、预发、生产）',
    description: '新的发布任务计划',
  })
  @Post('publishNew')
  @Public()
  async publishNew(
    @Body() publishNewDto: PublishNewDto,
  ): Promise<typeof DEFAULT_QUEUE_ID> {
    console.log('publishNewDto', publishNewDto);
    if (publishNewDto.projectType === 'gateway' && getEnv() !== 'prod') {
      throw new BusinessException('研发工作台线下环境禁止发布网关服务');
    }

    const {
      extra,
      publishType,
      taskId: ironTaskId,
      projectType,
      deployVersion,
      appId,
      environment,
      targetBranch,
      userId,
      userEmail,
      userName,
      desc,
      iterationId,
      domainId,
    } = publishNewDto;

    // FIXME optimus 传了这个过来，这是用不上的
    const iteration: Iteration =
      await this.iterationService.findIterationById(iterationId);

    const project: Project = await this.projectService.findProjectById(appId);

    // 校验发布环境合法性
    const expectedDeployEnv =
      publishNewDto.environment === ProcessNodes.pre
        ? ENV_NODES.fix
        : publishNewDto.environment;
    // TODO deployEnv 语义不一致
    const deployEnv = getDeployEnv(publishNewDto.environment);

    // 判断发布配置选项
    const projectConfiguration: ProjectConfiguration =
      await this.projectConfigurationService.findOne(project.id, projectType);

    if (
      isEmpty(projectConfiguration?.deployConfig || project.deployConfig) &&
      projectType !== 'iOS' &&
      projectType !== 'nodejs' &&
      projectType !== 'android'
    ) {
      throw new BusinessException('请先设置应用发布配置！');
    }

    // 网关特殊任务修改
    const {
      NACOS_CONFIG = '',
      TASK_NACOS_CONFIG = '',
      domain,
    }: {
      NACOS_CONFIG: any;
      TASK_NACOS_CONFIG: any;
      domain: any;
    } = await this.packageNacos(publishNewDto, deployEnv);

    let task: Task;
    try {
      // 创建 任务
      task = await this.taskService.publish({
        projectType,
        env: environment,
        branch: targetBranch,
        creatorId: userId,
        creatorName: userName,
        processId: '',
        projectId: appId,
        iterationId: 0,
        version: deployVersion,
        status: PublishStatus.publishing,
        queueId: 0,
        desc,
        nacosConfig: JSON.stringify(TASK_NACOS_CONFIG),
        ironTaskId,
        domainId,
      });
    } catch (error) {
      throw new BusinessException(error);
    }

    if (!task) {
      throw new BusinessException('任务创建失败');
    }

    // 触发 Jenkins
    let jenkinsParams: H5JenkinsParams = {
      DEPLOY_CONFIG: projectConfiguration?.deployConfig || project.deployConfig, // 前端发布配置
      NACOS_CONFIG: NACOS_CONFIG.url
        ? JSON.stringify(NACOS_CONFIG)
        : projectConfiguration?.nacosConfig || project.nacosConfig, // 前端发布 nacos 配置
      PROJECT_GIT_PATH: `${project.gitProjectUrl.replace('http://', '')}.git`, // 项目 git 地址
      PROJECT_NAME: project.gitProjectName, // 项目 git 名称
      PROJECT_VERSION: deployVersion, // 迭代版本
      BRANCH_NAME: targetBranch, // 发布分支
      CACHE: !!publishNewDto.cache, // 是否缓存
      PIPELINE_STEPS: JSON.stringify({
        dependencies: true,
        build: true,
        test: false,
        deploy: true,
      }), // 构建步骤
      PROJECT_ID: project.id, // 项目 id
      COMMITS_SHA: '', // 提交sha
      DEPLOY_ENV:
        publishNewDto.environment === ProcessNodes.pre ? 'pre' : deployEnv, // 发布环境
      DOCKER_PUBLISHER:
        projectConfiguration?.builderDocker || DOCKER_PUBLISHER[projectType], // 构建 docker 版本
      USER_EMAIL: userEmail, // 发布人员邮箱
      NAMESPACE: `${project.gitNamespace}/${project.gitProjectName}`, // git namespace
      TASK_ID: task.id, // 任务 id，方便回调
      ARCHIVE_USER: userName, // 发布人
      DESC: desc, // 发布描述
      RESOURCE: 'iron',
      SHIELD_WEB_CONFIG: JSON.stringify({
        name: project.gitProjectName,
        remoteApps: {},
      }),
      EXTRA: extra || '{}',
    };

    // 三方小程序配置项
    if (projectType === 'weapp3rd') {
      const extraParams = await this.packageWeapp3rd(
        publishNewDto,
        project,
        expectedDeployEnv,
        task,
        projectConfiguration,
      );
      jenkinsParams = { ...jenkinsParams, ...extraParams };
    }

    if (
      isProjectTypeSupportMicroFe(projectType) &&
      publishNewDto.microModules?.length
    ) {
      // 微服务配置
      if (publishType === PublishTypeEnum.buildAndDeploy) {
        const extraParams = await this.packageMicrofe(
          publishNewDto,
          project,
          domain,
          task,
          iteration,
          publishNewDto.environment === ProcessNodes.pre ? 'pre' : deployEnv,
        );
        jenkinsParams = { ...jenkinsParams, ...extraParams };
      }

      // 微服务直接修改nacos
      if (publishType === PublishTypeEnum.deployOnly) {
        const html = await this.nacosService.getHtml(
          expectedDeployEnv,
          NACOS_CONFIG,
        );
        const { SHIELD_WEB_CONFIG } = await this.packageMicrofe(
          publishNewDto,
          project,
          domain,
          task,
          iteration,
          deployEnv,
        );
        const shieldWebConfig = JSON.parse(SHIELD_WEB_CONFIG || '{}');
        if (shieldWebConfig.config) {
          shieldWebConfig.config = JSON.parse(shieldWebConfig.config);
        }
        const injectHtml = injectShieldConfig(html, shieldWebConfig);
        await this.nacosService.uploadHtml(
          expectedDeployEnv,
          { nacosGroup: NACOS_CONFIG.group, ...NACOS_CONFIG },
          injectHtml,
        );
        this.deployHistoryService.saveProduct({
          task,
          htmlStr: injectHtml,
          iterationId: iteration?.id,
          version: deployVersion,
        });
        return DEFAULT_QUEUE_ID;
      }
    }

    // npm 配置项附增
    if (projectType === 'npm') {
      if (expectedDeployEnv !== ProcessNodes.production) {
        const lastTask = await this.taskService.getAppLatestTaskOnEnv(
          {
            projectId: appId,
            env: environment,
          },
          [task.id],
        );
        let prereleaseVer = 1;
        if (lastTask) {
          const [_, prevPrereleaseVer] = semver.prerelease(
            lastTask.version,
          ) || [null, 0];
          prereleaseVer = prevPrereleaseVer + 1;
        }
        task.version = `${deployVersion}-${versionTypeMap[expectedDeployEnv]}.${prereleaseVer}`;
      }
      jenkinsParams = {
        ...jenkinsParams,
        ...{
          PROJECT_VERSION: task.version,
          PROJECT_NAME: project.usName,
        },
      };
    }

    try {
      const { data } = await this.jenkinsService.buildH5({
        type: projectType,
        job: JENKINS_MAP[projectType],
        params: jenkinsParams,
      });
      if (!data.queueId) {
        throw new Error('empty queueId');
      }
      this.taskService.updateById(task.id, { ...task, queueId: data.queueId });
      return data.queueId;
    } catch (error) {
      this.taskService.updateById(task.id, {
        ...task,
        status: PublishStatus.publish_failed,
      });
      console.error(error);
      // 抛出错误给上游服务使用
      throw new BusinessException(
        'Jenkins 服务创建构建任务异常' + error?.message,
      );
    }
  }

  @ApiOperation({
    summary: '获取task详情',
  })
  @Post('detail')
  async getSingle(
    @Body() singleDto: { taskId: number },
  ): Promise<Task & { job?: string }> {
    const { taskId } = singleDto;
    const task = await this.taskService.findById(taskId);
    if (!task) return task;
    return {
      ...task,
      job: JENKINS_MAP[task.projectType],
    };
  }

  @ApiOperation({
    summary: '任务列表（分页）',
  })
  @Post('list/pagination')
  async listWithPagination(
    @Body() listWithPaginationDto: ListWithPaginationDto,
  ): Promise<Pagination<Task, CustomPaginationMeta>> {
    const { page, ...searchCondition } = listWithPaginationDto;
    return await this.taskService.paginate(searchCondition, page);
  }

  @ApiOperation({
    summary: '根据 iron taskId 获取任务额外信息',
  })
  @Post('queryExtraByIronTaskId')
  async queryExtraByIronTaskId(
    @Body()
    { ironTaskId, fields = [TaskExtraFields.version] }: QueryByIronTaskIdDto,
  ) {
    const task = await this.taskService.findByIronTaskId(ironTaskId);
    if (!task) return {};

    const data: any = {
      version: task.version,
    };

    if (fields?.includes(TaskExtraFields.microConfig)) {
      const deployHistory = await this.deployHistoryService.findOneByTaskId(
        task.id,
      );
      if (deployHistory?.microConfig) {
        const envName = getEnvName(deployHistory.environment);
        const microConfigData = [];
        for (const microConfigItem of deployHistory.microConfig) {
          const project = await this.projectService.findProjectById(
            microConfigItem.projectId,
            true,
          );
          const iteration = await this.iterationService.findIterationById(
            microConfigItem.iterationId,
          );
          const version = iteration?.version;
          const iterationId = microConfigItem.iterationId;
          microConfigData.push({
            ...project,
            version,
            iterationId,
            assertUrl: getAssetUrl({
              assetPath: this.ASSETS_PATH[envName],
              gitProjectName: project.gitProjectName,
              version: version,
              withHtml: true,
            }),
          });
        }
        data.microConfigData = microConfigData;
      }
    }
    return data;
  }

  @Post('rollback/diff')
  @Public()
  async getRollbackDiff(@Body() rollbackDiffDto: RollbackDiffDto) {
    const [onlineHistory, rollbackHistory] = await Promise.all([
      this.deployHistoryService.getHistoryLatest({
        projectId: rollbackDiffDto.appId,
        projectType: rollbackDiffDto.projectType,
        environment: ProcessNodes.production,
        version: rollbackDiffDto.onlineVersion,
        domainId: rollbackDiffDto.domainId,
      }),
      this.deployHistoryService.getHistoryLatest({
        projectId: rollbackDiffDto.appId,
        projectType: rollbackDiffDto.projectType,
        environment: ProcessNodes.production,
        version: rollbackDiffDto.rollbackVersion,
        domainId: rollbackDiffDto.domainId,
      }),
    ]);
    return {
      online: onlineHistory || null,
      rollback: rollbackHistory || null,
    };
  }

  @ApiOperation({
    summary: '回滚任务执行',
  })
  @Post('rollback')
  async rollback(
    @Body()
    rollbackDto: RollbackDto,
  ) {
    if (!['web', 'gateway'].includes(rollbackDto.projectType)) {
      throw new BusinessException(
        `尚不支持${rollbackDto.projectType}类型应用回滚`,
      );
    }

    const project: Project = await this.projectService.findProjectById(
      rollbackDto.appId,
    );
    if (!project) {
      throw new BusinessException('应用不存在');
    }

    if (getEnv() !== 'prod') {
      throw new BusinessException('研发工作台线下环境禁止发布网关服务');
    }

    const rollbackHistory = await this.deployHistoryService.getHistoryLatest({
      projectId: rollbackDto.appId,
      projectType: rollbackDto.projectType,
      environment: ProcessNodes.production,
      version: rollbackDto.rollbackVersion,
      domainId: rollbackDto.domainId,
    });
    if (!rollbackHistory?.htmlAdr) {
      throw new BusinessException('未找到制品信息');
    }
    const html = await getHtml(rollbackHistory.htmlAdr);
    if (!html?.data) {
      throw new BusinessException('制品数据为空');
    }

    switch (rollbackDto.projectType) {
      case 'gateway':
        // 获取最新的 nacos 配置重新部署
        const { NACOS_CONFIG }: { NACOS_CONFIG: any } = await this.packageNacos(
          {
            projectType: rollbackDto.projectType,
            environment: ProcessNodes.production,
            domainId: rollbackDto.domainId,
            nodeId: 1,
          },
          getEnvName(ProcessNodes.production),
        );

        await this.nacosService.uploadHtml(
          ProcessNodes.production,
          { nacosGroup: NACOS_CONFIG.group, ...NACOS_CONFIG },
          html.data,
        );
        return;
      case 'web':
        const projectConfiguration: ProjectConfiguration =
          await this.projectConfigurationService.findOne(
            rollbackDto.appId,
            rollbackDto.projectType,
          );
        const nacosConfigWithEnv = JSON.parse(
          projectConfiguration?.nacosConfig || project.nacosConfig,
        );
        await this.nacosService.uploadHtmlToNacos(
          {
            ...nacosConfigWithEnv.default,
            ...nacosConfigWithEnv.prod,
          },
          html.data,
        );
        return;
    }
  }
}
