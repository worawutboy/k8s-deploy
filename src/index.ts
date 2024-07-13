const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const path = require("path");

async function run() {
  try {
    const service_name = core.getInput("service_name");
    const namespace = core.getInput("namespace");
    const host = core.getInput("host");
    const kubeconfig = core.getInput("kubeconfig");
    const ghToken = core.getInput("gh_token");
    const dockerImage = core.getInput("docker_image");
    const envVarsInput = core.getInput("env_vars");
    const runMode = core.getInput("run_mode");
    const dockerUsername = core.getInput("docker_username");
    const withIngress = core.getInput("with_ingress");
    if (withIngress === "true" && !host) {
      throw new Error("Host is required when with_ingress is true");
    }

    // Set up kubeconfig if not exists in the runner machine created by the action
    if (!fs.existsSync("/home/runner/.kube")) {
      fs.mkdirSync("/home/runner/.kube");
    }
    fs.writeFileSync(
      "/home/runner/.kube/config",
      Buffer.from(kubeconfig, "base64").toString("utf8")
    );

    // Create namespace if it does not exist
    await exec.exec(
      `sh -c "kubectl get namespace ${namespace} || kubectl create namespace ${namespace}"`
    );

    // Create or update Docker registry secret
    await exec.exec(
      `sh -c "kubectl create secret docker-registry ghcr-secret --docker-server=ghcr.io --docker-username=${dockerUsername} --docker-password=${ghToken} --namespace=${namespace} --dry-run=client -o yaml | kubectl apply -f -"`,
      [],
      { shell: true }
    );

    // Prepare environment variables
    const envVars = envVarsInput.split(",").map((env: any) => {
      const [name, value] = env.split("=");
      return { name: (name as string).replace("ENV_", ""), value };
    });

    // Create deployment YAML
    const deploymentYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${service_name}
  namespace: ${namespace}
  labels:
    app: ${service_name}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ${service_name}
  template:
    metadata:
      labels:
        app: ${service_name}
    spec:
      imagePullSecrets:
        - name: ghcr-secret
      containers:
        - name: ${service_name}
          image: ${dockerImage}
          ports:
            - containerPort: 3000
          env:
${envVars
  .map(
    (env: any) =>
      `            - name: ${env.name}\n              value: '${env.value}'`
  )
  .join("\n")}
`;

    // Create service YAML
    const serviceYaml = `
apiVersion: v1
kind: Service
metadata:
  name: ${service_name}
  namespace: ${namespace}
spec:
  selector:
    app: ${service_name}
  ports:
    - protocol: TCP
      port: 80
      targetPort: 3000
  type: ClusterIP
`;

    // Create ingress YAML
    const ingressYaml = `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${service_name}
  namespace: ${namespace}
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${service_name}
                port:
                  number: 80
`;

    // Write YAML files to disk
    const deploymentFile = path.join("/home/runner/deployment.yaml");
    const serviceFile = path.join("/home/runner/service.yaml");
    const ingressFile = path.join("/home/runner/ingress.yaml");
    const bridgeServiceFile = path.join("/home/runner/bridge-service.yaml");
    fs.writeFileSync(deploymentFile, deploymentYaml);
    fs.writeFileSync(serviceFile, serviceYaml);
    if (withIngress === "true") {
      fs.writeFileSync(ingressFile, ingressYaml);
    }
    if (runMode === "dry-run") {
      // Output YAML files
      core.info("Deployment YAML:");
      core.info(deploymentYaml);
      core.info("Service YAML:");
      core.info(serviceYaml);
      if (withIngress === "true") core.info("Ingress YAML:");
      core.info(ingressYaml);

      core.info("Dry run mode, exiting...");
      return;
    }
    // Apply Kubernetes manifests
    await exec.exec(`sh -c "kubectl apply -f ${deploymentFile}"`);
    await exec.exec(`sh -c "kubectl apply -f ${serviceFile}"`);
    if (withIngress === "true") {
      await exec.exec(`sh -c "kubectl apply -f ${ingressFile}"`);
    }
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
